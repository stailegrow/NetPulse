//! Инциденты, операторы и Телеграм-бот внутри движка.

use super::*;
use crate::incidents::{self as inc, Change};
use crate::telegram as tg;

/// Черновик заявки оператору.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketDraft {
    pub operator_id: Option<String>,
    pub operator_name: Option<String>,
    pub to: Option<String>,
    pub subject: String,
    pub body: String,
}

/// Уведомление по инциденту для системных уведомлений и окна программы.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentNotice {
    /// open | close | remind | demo
    pub event: String,
    pub title: String,
    pub body: String,
    /// critical | warning | ok
    pub severity: String,
    pub incident: Incident,
}

/// Через сколько после запуска сверять открытые инциденты с реальным состоянием целей.
const RECONCILE_AFTER_MS: i64 = 3 * 60_000;

fn short_problem(a: &Alert) -> String {
    if a.kind == "down" {
        return "недоступен".into();
    }
    let first = a.message.lines().next().unwrap_or("");
    let body = first.split_once(": ").map(|x| x.1).unwrap_or(first);
    body.split(" — ").next().unwrap_or(body).trim().to_string()
}

fn cause_of(a: &Alert) -> Option<String> {
    a.message.split_once("\nПричина: ").map(|x| x.1.lines().next().unwrap_or("").trim().to_string()).filter(|s| !s.is_empty())
}

fn local_hour(ms: i64) -> u32 {
    use chrono::{TimeZone, Timelike};
    chrono::Local.timestamp_millis_opt(ms).single().map(|d| d.hour()).unwrap_or(0)
}

fn local_day(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

fn in_quiet(rules: &AlertRules, now: i64) -> bool {
    if !rules.quiet_enabled || rules.quiet_from == rules.quiet_to {
        return false;
    }
    let h = local_hour(now) as u8;
    let (a, b) = (rules.quiet_from.min(23), rules.quiet_to.min(23));
    if a < b { h >= a && h < b } else { h >= a || h < b }
}

/// Текст без HTML-разметки — для почты и вебхука.
fn plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut tag = false;
    for c in html.chars() {
        match c {
            '<' => tag = true,
            '>' => tag = false,
            _ if !tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

impl Monitor {
    // ------------------------------------------------------------ операторы

    pub(super) fn load_operators(&self) {
        if let Ok(Some(j)) = self.storage.get_kv("operators") {
            if let Ok(list) = serde_json::from_str::<Vec<Operator>>(&j) {
                *self.operators.write() = list;
            }
        }
    }

    fn store_operators(&self) -> Result<()> {
        let j = serde_json::to_string(&*self.operators.read())?;
        self.storage.set_kv("operators", &j)
    }

    pub fn operators(&self) -> Vec<Operator> {
        let mut v = self.operators.read().clone();
        v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        v
    }

    pub fn save_operator(&self, mut op: Operator) -> Result<Operator> {
        op.name = op.name.trim().to_string();
        if op.name.is_empty() {
            return Err(anyhow!("укажите название оператора"));
        }
        if op.id.is_empty() {
            op.id = uuid::Uuid::new_v4().to_string();
        }
        for s in op.services.iter_mut() {
            if s.id.is_empty() {
                s.id = uuid::Uuid::new_v4().to_string();
            }
            if s.role.is_empty() {
                s.role = "primary".into();
            }
            s.targets.dedup();
            s.groups.retain(|g| !g.trim().is_empty());
        }
        op.phones.retain(|c| !c.value.trim().is_empty());
        op.emails.retain(|c| !c.value.trim().is_empty());
        {
            let mut list = self.operators.write();
            match list.iter_mut().find(|x| x.id == op.id) {
                Some(x) => *x = op.clone(),
                None => list.push(op.clone()),
            }
        }
        self.store_operators()?;
        Ok(op)
    }

    pub fn delete_operator(&self, id: &str) -> Result<()> {
        self.operators.write().retain(|x| x.id != id);
        self.store_operators()
    }

    pub(super) fn import_operators(&self, list: Vec<Operator>) -> Result<()> {
        for op in list {
            let mut cur = self.operators.write();
            match cur.iter_mut().find(|x| x.id == op.id || x.name.eq_ignore_ascii_case(&op.name)) {
                Some(x) => *x = Operator { id: x.id.clone(), ..op },
                None => cur.push(op),
            }
        }
        self.store_operators()
    }

    /// Операторы цели: сначала по услугам, привязанным к цели, потом к её группе,
    /// основной раньше резервного. Если ничего не привязано — подсказка по именам хопов.
    pub fn target_operators(&self, id: &str) -> Vec<TargetOperator> {
        let Some(t) = self.runners.read().get(id).map(|r| r.target.read().clone()) else { return vec![] };
        let ops = self.operators.read();
        let mut out: Vec<TargetOperator> = Vec::new();
        for via in ["target", "group"] {
            for op in ops.iter() {
                for s in &op.services {
                    let hit = if via == "target" { s.targets.iter().any(|x| x == id) } else { s.groups.iter().any(|g| g == &t.group) };
                    if hit && !out.iter().any(|o| o.operator.id == op.id && o.service.as_ref().map(|x| &x.id) == Some(&s.id)) {
                        out.push(TargetOperator { operator: op.clone(), service: Some(s.clone()), via: via.into() });
                    }
                }
            }
        }
        out.sort_by_key(|o| (o.service.as_ref().map_or(1, |s| (s.role == "backup") as u8), (o.via != "target") as u8));
        if out.is_empty() {
            if let Some(op) = self.hint_operator(id, &ops) {
                out.push(TargetOperator { operator: op, service: None, via: "hint".into() });
            }
        }
        out
    }

    /// Оператор по именам хопов маршрута: домен или слово из карточки оператора встречается в имени.
    fn hint_operator(&self, id: &str, ops: &[Operator]) -> Option<Operator> {
        let names = self.hostnames();
        let route: Vec<IpAddr> = {
            let r = self.runners.read().get(id).cloned()?;
            let st = r.state.lock();
            let src = if !st.route.is_empty() { &st.route } else { &st.map_route };
            src.iter().flatten().copied().collect()
        };
        for ip in route.iter().rev() {
            let Some(n) = names.get(ip) else { continue };
            let n = n.to_lowercase();
            for op in ops {
                let hit = op.domains.split([',', ' ', ';']).map(|d| d.trim().to_lowercase()).filter(|d| d.len() >= 3).any(|d| n.contains(&d));
                if hit {
                    return Some(op.clone());
                }
            }
        }
        None
    }

    fn incident_operators(&self, i: &Incident) -> Vec<TargetOperator> {
        for t in &i.targets {
            let v = self.target_operators(&t.id);
            if !v.is_empty() {
                return v;
            }
        }
        vec![]
    }

    /// Текст заявки оператору по инциденту или по цели.
    pub fn ticket_draft(&self, incident_id: Option<&str>, target_id: Option<&str>, operator_id: Option<&str>) -> Result<TicketDraft> {
        let now = now_ms();
        let incident = incident_id.and_then(|id| self.find_incident(id));
        let tid = target_id.map(str::to_string).or_else(|| incident.as_ref().and_then(|i| i.targets.first().map(|t| t.id.clone())));
        let tid = tid.ok_or_else(|| anyhow!("не указана цель"))?;
        let ops = match &incident {
            Some(i) => self.incident_operators(i),
            None => self.target_operators(&tid),
        };
        let pick = operator_id.and_then(|oid| ops.iter().find(|o| o.operator.id == oid)).or(ops.first());
        let (t, summary, hops) = {
            let r = self.runners.read().get(&tid).cloned().ok_or_else(|| anyhow!("цель не найдена"))?;
            let t = r.target.read().clone();
            let rules = self.settings.read().alert_rules.clone();
            let st = r.state.lock();
            let sum = summarize(&t, &st, &rules, now);
            let hops: Vec<(u8, Option<IpAddr>, Option<f32>)> = st.recent.iter().rev().find(|s| !s.hops.is_empty()).map(|s| s.hops.iter().map(|h| (h.ttl, h.addr, h.rtt_ms)).collect()).unwrap_or_default();
            (t, sum, hops)
        };
        let s = self.settings();
        let since = incident.as_ref().map(|i| i.opened).unwrap_or(summary.state_since.max(now - 3_600_000));
        let down = incident.as_ref().map_or(summary.health == Health::Down, |i| i.kind == "down");
        let svc = pick.and_then(|p| p.service.clone());
        let op = pick.map(|p| p.operator.clone());
        let what = if down { "нет связи" } else { "ухудшение связи" };
        let mut subj = vec![format!("{}{}", what[..2].to_uppercase(), &what[2..])];
        if let Some(sv) = &svc {
            if !sv.number.is_empty() {
                subj.push(format!("услуга {}", sv.number));
            }
            if !sv.address.is_empty() {
                subj.push(sv.address.clone());
            }
        }
        if subj.len() == 1 {
            subj.push(t.name.clone());
        }
        let mut b = vec!["Здравствуйте!".to_string()];
        if let Some(o) = &op {
            let mut d = Vec::new();
            if !o.contract.is_empty() {
                d.push(format!("Договор № {}", o.contract));
            }
            if !o.account.is_empty() {
                d.push(format!("л/с {}", o.account));
            }
            if !d.is_empty() {
                b.push(format!("{}.", d.join(", ")));
            }
        }
        let svc_txt = svc.as_ref().filter(|s| !s.number.is_empty()).map(|s| format!(" по услуге {}", s.number)).unwrap_or_default();
        b.push(format!("С {} {}{svc_txt}.", inc::day_clock(since), what));
        if let Some(sv) = &svc {
            if !sv.address.is_empty() {
                b.push(format!("Адрес подключения: {}.", sv.address));
            }
            if !sv.ips.is_empty() {
                b.push(format!("Наши адреса: {}.", sv.ips));
            }
        }
        let ip = summary.resolved_ip.clone().unwrap_or_else(|| t.host.clone());
        b.push(String::new());
        if down {
            b.push(format!("Узел {} ({ip}) не отвечает, потери {:.0}%.", t.name, summary.loss_pct));
        } else {
            let avg = summary.avg_rtt.map(|v| format!("{v:.0} мс")).unwrap_or_else(|| "—".into());
            b.push(format!("Узел {} ({ip}): потери {:.0}%, средняя задержка {avg}.", t.name, summary.loss_pct));
        }
        if let Some(c) = incident.as_ref().and_then(|i| i.cause.clone()).or(summary.cause.clone()) {
            b.push(format!("Наш анализ: {c}."));
        }
        if !hops.is_empty() {
            // Трассировка до места обрыва: последний ответивший хоп и следующий за ним.
            let last = hops.iter().rposition(|h| h.1.is_some()).unwrap_or(0);
            let end = (last + 2).min(hops.len());
            b.push("Трассировка:".into());
            let names = self.hostnames();
            for (ttl, addr, rtt) in &hops[..end] {
                let a = addr.map(|a| a.to_string()).unwrap_or_else(|| "* * *".into());
                let n = addr.and_then(|a| names.get(&a).cloned()).map(|n| format!(" {n}")).unwrap_or_default();
                let r = rtt.map(|v| format!("{v:.1} мс")).unwrap_or_else(|| "нет ответа".into());
                b.push(format!("  {ttl:>2}  {a}{n}  {r}"));
            }
        }
        b.push(String::new());
        b.push("Просим проверить и сообщить номер заявки.".into());
        let sign: Vec<String> = [s.duty_name.trim(), s.duty_contact.trim()].iter().filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
        if !sign.is_empty() {
            b.push(format!("Контакт: {}", sign.join(", ")));
        }
        Ok(TicketDraft {
            operator_id: op.as_ref().map(|o| o.id.clone()),
            operator_name: op.as_ref().map(|o| o.name.clone()),
            to: op.as_ref().and_then(|o| o.emails.first().map(|e| e.value.clone())),
            subject: subj.join(" · "),
            body: b.join("\n"),
        })
    }

    // ------------------------------------------------------------ инциденты

    pub(super) fn load_open_incidents(&self) {
        if let Ok(list) = self.storage.open_incidents() {
            *self.incidents.lock() = list;
        }
    }

    fn find_incident(&self, id: &str) -> Option<Incident> {
        if let Some(i) = self.incidents.lock().iter().find(|i| i.id == id) {
            return Some(i.clone());
        }
        self.storage.incidents(0, i64::MAX, 2000).ok()?.into_iter().find(|i| i.id == id)
    }

    fn apply_change(&self, ch: Change) {
        if ch.touched.is_empty() {
            return;
        }
        let list = self.incidents.lock();
        for id in &ch.touched {
            if let Some(i) = list.iter().find(|i| &i.id == id) {
                let _ = self.storage.save_incident(i);
            }
        }
        drop(list);
        self.inc_dirty.lock().extend(ch.touched);
    }

    fn failed_ancestor_id(&self, id: &str) -> Option<String> {
        let runners = self.runners.read();
        let mut cur = runners.get(id).and_then(|r| r.target.read().parent_id.clone());
        let mut depth = 0;
        while let Some(pid) = cur {
            depth += 1;
            if depth > 32 {
                break;
            }
            let r = runners.get(&pid)?;
            let t = r.target.read();
            if t.enabled && r.state.lock().alert.down {
                return Some(pid.clone());
            }
            cur = t.parent_id.clone();
        }
        None
    }

    /// Событие цели → инцидент. Вызывается из emit.
    pub(super) fn feed_incident(&self, a: &Alert) {
        if a.message.starts_with('⏱') {
            return;
        }
        let Some(r) = self.runners.read().get(&a.target_id).cloned() else { return };
        let t = r.target.read().clone();
        let now = now_ms();
        if inc::is_problem(&a.kind) {
            let ancestor = self.failed_ancestor_id(&t.id);
            let ch = inc::on_problem(&mut self.incidents.lock(), &t, &a.kind, &short_problem(a), cause_of(a).as_deref(), ancestor.as_deref(), now);
            self.apply_change(ch);
        } else if inc::is_recovery(&a.kind) {
            let still = {
                let st = r.state.lock();
                st.alert.loss || st.alert.latency || st.alert.jitter || st.alert.mos
            };
            let ch = inc::on_recovery(&mut self.incidents.lock(), &t, &a.kind, still, now);
            self.apply_change(ch);
        }
    }

    /// Цель удалена или выключена — её проблемы больше не считаем.
    pub(super) fn incident_drop_target(&self, id: &str, why: &str) {
        let ch = inc::drop_target(&mut self.incidents.lock(), id, why, now_ms());
        self.apply_change(ch);
    }

    /// Открытые инциденты и история за период, новые сверху.
    pub fn incidents(&self, from: i64, to: i64, limit: usize) -> Result<Vec<Incident>> {
        let mut list = self.storage.incidents(from, to, limit)?;
        let mem = self.incidents.lock().clone();
        for m in mem {
            match list.iter_mut().find(|x| x.id == m.id) {
                Some(x) => *x = m,
                None if m.opened < to => list.push(m),
                None => {}
            }
        }
        list.sort_by(|a, b| b.opened.cmp(&a.opened));
        Ok(list)
    }

    fn update_incident(&self, id: &str, f: impl FnOnce(&mut Incident)) -> Result<Incident> {
        let mut list = self.incidents.lock();
        let i = match list.iter_mut().find(|i| i.id == id) {
            Some(i) => i,
            None => {
                // Закрытый инцидент из истории — правим прямо в базе (заявка задним числом).
                drop(list);
                let mut i = self.find_incident(id).ok_or_else(|| anyhow!("инцидент не найден"))?;
                f(&mut i);
                self.storage.save_incident(&i)?;
                return Ok(i);
            }
        };
        f(i);
        let out = i.clone();
        self.storage.save_incident(&out)?;
        drop(list);
        self.inc_dirty.lock().insert(id.to_string());
        Ok(out)
    }

    fn duty(&self) -> String {
        let n = self.settings.read().duty_name.trim().to_string();
        if n.is_empty() { "дежурный".into() } else { n }
    }

    pub fn incident_ack(&self, id: &str, by: Option<&str>) -> Result<Incident> {
        let by = by.map(str::to_string).unwrap_or_else(|| self.duty());
        self.update_incident(id, |i| {
            inc::ack(i, &by, now_ms());
        })
    }

    pub fn incident_mute(&self, id: &str, minutes: i64, by: Option<&str>) -> Result<Incident> {
        let by = by.map(str::to_string).unwrap_or_else(|| self.duty());
        self.update_incident(id, |i| inc::mute(i, minutes, &by, now_ms()))
    }

    pub fn incident_ticket(&self, id: &str, operator_id: &str, number: &str) -> Result<Incident> {
        let by = self.duty();
        let name = self.operators.read().iter().find(|o| o.id == operator_id).map(|o| o.name.clone()).unwrap_or_default();
        self.update_incident(id, |i| {
            let now = now_ms();
            let n = number.trim().to_string();
            inc::log(i, now, format!("Обращение к оператору {}{}", if name.is_empty() { "—".into() } else { name.clone() }, if n.is_empty() { String::new() } else { format!(", заявка № {n}") }));
            i.ticket = Some(IncidentTicket { operator_id: operator_id.into(), operator_name: name.clone(), number: n, by: by.clone(), at: now });
            if i.ack_by.is_none() {
                inc::ack(i, &by, now);
            }
        })
    }

    pub fn incident_note(&self, id: &str, text: &str) -> Result<Incident> {
        let by = self.duty();
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(anyhow!("пустая заметка"));
        }
        self.update_incident(id, |i| inc::log(i, now_ms(), format!("{by}: {text}")))
    }

    /// Простой по дням и часам для всех целей за период.
    pub fn downtime_profiles(&self, from: i64, to: i64) -> Result<Vec<DowntimeProfile>> {
        let ids: Vec<String> = self.order.read().clone();
        let mut out = Vec::new();
        for id in ids {
            out.push(self.storage.downtime_profile(&id, from, to)?);
        }
        Ok(out)
    }

    // ------------------------------------------------------------ уведомления

    fn notify_local(&self, i: &Incident, ops: &[TargetOperator], event: &str, now: i64) {
        let (title, body) = tg::notice_text(i, ops, now, event);
        let severity = if event == "close" { "ok".to_string() } else { i.severity.clone() };
        let _ = self.inc_tx.send(IncidentNotice { event: event.into(), title, body, severity, incident: i.clone() });
    }

    /// Пример инцидента: как будут выглядеть сообщения в Телеграме и уведомления на компьютере.
    pub async fn incident_demo(&self) -> Result<String> {
        let now = now_ms();
        let list = self.list_targets();
        let t = list.iter().find(|t| t.enabled).or(list.first());
        let (name, host, group, id) = match t {
            Some(t) => (if t.name.is_empty() { t.host.clone() } else { t.name.clone() }, t.host.clone(), t.group.clone(), t.id.clone()),
            None => ("Узел".to_string(), "192.0.2.10".to_string(), String::new(), String::new()),
        };
        let mut i = Incident {
            id: "demo".into(),
            opened: now - 4 * 60_000,
            severity: "critical".into(),
            kind: "down".into(),
            group,
            cause: Some("пример: обрыв после хопа 4 — сеть оператора".into()),
            targets: vec![IncidentTarget { id: id.clone(), name, host, since: now - 4 * 60_000, until: None, problem: "недоступен".into() }],
            ..Default::default()
        };
        inc::retitle(&mut i);
        i.title = format!("Проверка · {}", i.title);
        let ops = if id.is_empty() { Vec::new() } else { self.target_operators(&id) };
        self.notify_local(&i, &ops, "demo", now);
        let s = self.settings();
        let tgc = s.channels.telegram.clone();
        if !(tgc.enabled && !tgc.bot_token.is_empty() && !tgc.chat_id.is_empty()) {
            return Ok("Уведомление на компьютере показано. Телеграм не настроен — включите его и укажите токен и чат.".into());
        }
        let control = s.incident_control;
        let mut html = tg::incident_html(&i, &ops, now, control);
        html.push_str("\n\n<i>Это пример, а не авария. Так будет выглядеть сообщение: оно обновляется на месте — кто взял, заявка, восстановление.</i>");
        tg::send(&tgc.bot_token, &tgc.chat_id, &html, if control { tg::keyboard(&i, now) } else { None }, None).await?;
        Ok(if tgc.interactive || !control {
            "Пример отправлен в Телеграм и показан на компьютере.".into()
        } else {
            "Пример отправлен в Телеграм. Кнопки под сообщением заработают, когда включите «Отвечать на кнопки и команды» на этом компьютере.".into()
        })
    }

    /// Раз в несколько секунд: кому и что отправить по инцидентам.
    pub(super) async fn incident_tick(self: &Arc<Self>) {
        let now = now_ms();
        let settings = self.settings();
        let rules = settings.alert_rules.clone();
        let control = settings.incident_control;

        // После перезапуска сверяем оставшиеся открытыми инциденты с тем, что видно сейчас.
        if now - self.started_at > RECONCILE_AFTER_MS {
            let mut stale: Vec<(String, bool)> = Vec::new();
            for i in self.incidents.lock().iter().filter(|i| i.closed.is_none()) {
                for t in i.targets.iter().filter(|t| t.until.is_none()) {
                    let ok = match self.runners.read().get(&t.id) {
                        None => true,
                        Some(r) => {
                            let tt = r.target.read();
                            let st = r.state.lock();
                            !tt.enabled || if i.kind == "down" { !st.alert.down } else { !(st.alert.loss || st.alert.latency || st.alert.jitter || st.alert.mos) }
                        }
                    };
                    if ok {
                        stale.push((t.id.clone(), i.kind == "down"));
                    }
                }
            }
            for (id, down) in stale {
                if let Some(t) = self.runners.read().get(&id).map(|r| r.target.read().clone()) {
                    let kind = if down { "recovered" } else { "loss_ok" };
                    let ch = inc::on_recovery(&mut self.incidents.lock(), &t, kind, false, now);
                    self.apply_change(ch);
                } else {
                    self.incident_drop_target(&id, "цель удалена");
                }
            }
        }

        let tgc = settings.channels.telegram.clone();
        let tg_on = tgc.enabled && !tgc.bot_token.is_empty() && !tgc.chat_id.is_empty();
        let others_on = settings.channels.webhook.enabled || settings.channels.email.enabled;
        let dirty: HashSet<String> = std::mem::take(&mut *self.inc_dirty.lock());
        let quiet = in_quiet(&rules, now);

        // Что сделать: (инцидент, действие). Сеть — вне блокировок.
        enum Act { Open, Edit, Close, Remind, Forget }
        let mut todo: Vec<(Incident, Act)> = Vec::new();
        {
            let list = self.incidents.lock();
            for i in list.iter() {
                let silent = i.targets.iter().all(|t| self.runners.read().get(&t.id).map_or(true, |r| !r.target.read().alerts_enabled));
                let muted = i.muted_until.map_or(false, |m| m > now);
                match (i.notified_at, i.closed) {
                    (None, Some(_)) => todo.push((i.clone(), Act::Forget)),
                    (None, None) => {
                        let due = now - i.opened >= rules.notify_delay_sec as i64 * 1000;
                        let night_ok = !quiet || i.severity == "critical";
                        if due && !silent && !muted && night_ok {
                            todo.push((i.clone(), Act::Open));
                        }
                    }
                    (Some(_), Some(_)) => todo.push((i.clone(), Act::Close)),
                    (Some(at), None) => {
                        let remind_every = rules.repeat_minutes as i64 * 60_000;
                        if control && remind_every > 0 && i.ack_by.is_none() && !muted && now - i.reminded_at.unwrap_or(at) >= remind_every {
                            todo.push((i.clone(), Act::Remind));
                        } else if dirty.contains(&i.id) {
                            todo.push((i.clone(), Act::Edit));
                        }
                    }
                }
            }
        }

        for (i, act) in todo {
            let ops = self.incident_operators(&i);
            let html = tg::incident_html(&i, &ops, now, control);
            let kb = if control { tg::keyboard(&i, now) } else { None };
            match act {
                Act::Forget => {
                    // Короткая проблема, о которой не сообщали: только в истории.
                    self.incidents.lock().retain(|x| x.id != i.id);
                }
                Act::Open => {
                    let mut msg_id = None;
                    if tg_on {
                        match tg::send(&tgc.bot_token, &tgc.chat_id, &html, kb.clone(), None).await {
                            Ok(id) => msg_id = Some(id),
                            Err(e) => self.channel_error("telegram", &e.to_string()),
                        }
                    }
                    if others_on {
                        self.send_others(&settings, &plain(&html)).await;
                    }
                    let _ = self.update_incident(&i.id, |x| {
                        x.notified_at = Some(now);
                        if msg_id.is_some() {
                            x.tg_message_id = msg_id;
                        }
                    });
                    self.notify_local(&i, &ops, "open", now);
                    self.inc_dirty.lock().remove(&i.id);
                }
                Act::Edit => {
                    if let (true, Some(mid)) = (tg_on, i.tg_message_id) {
                        if let Err(e) = tg::edit(&tgc.bot_token, &tgc.chat_id, mid, &html, kb.clone()).await {
                            log::warn!("не удалось обновить сообщение инцидента: {e}");
                        }
                    }
                }
                Act::Remind => {
                    if tg_on {
                        let text = format!("⏱ Никто не взял: <b>{}</b> · длится {}", tg::esc(&i.title), inc::duration(now - i.opened));
                        if let Err(e) = tg::send(&tgc.bot_token, &tgc.chat_id, &text, kb.clone(), i.tg_message_id).await {
                            self.channel_error("telegram", &e.to_string());
                        }
                    }
                    let _ = self.update_incident(&i.id, |x| x.reminded_at = Some(now));
                    self.notify_local(&i, &ops, "remind", now);
                    self.inc_dirty.lock().remove(&i.id);
                }
                Act::Close => {
                    if tg_on {
                        match i.tg_message_id {
                            Some(mid) => {
                                if let Err(e) = tg::edit(&tgc.bot_token, &tgc.chat_id, mid, &html, None).await {
                                    log::warn!("не удалось обновить сообщение инцидента: {e}");
                                }
                            }
                            None => {
                                let _ = tg::send(&tgc.bot_token, &tgc.chat_id, &html, None, None).await;
                            }
                        }
                        // Короткий ответ на исходное сообщение: в чате приходит уведомление о восстановлении.
                        if rules.notify_recovery {
                            let text = format!("✅ Восстановлено: {} · простой {}", tg::esc(&i.title), inc::duration(inc::length(&i, now)));
                            let _ = tg::send(&tgc.bot_token, &tgc.chat_id, &text, None, i.tg_message_id).await;
                        }
                    }
                    if others_on && rules.notify_recovery {
                        self.send_others(&settings, &plain(&html)).await;
                    }
                    if rules.notify_recovery {
                        self.notify_local(&i, &ops, "close", now);
                    }
                    self.incidents.lock().retain(|x| x.id != i.id);
                }
            }
        }

        // Утренняя сводка.
        if tg_on && rules.digest_enabled && local_hour(now) == rules.digest_hour as u32 {
            let today = local_day(now);
            if self.storage.get_kv("digest_day").ok().flatten().as_deref() != Some(today.as_str()) {
                let since = self.storage.get_kv("digest_at").ok().flatten().and_then(|v| v.parse::<i64>().ok()).unwrap_or(now - 86_400_000).max(now - 3 * 86_400_000);
                let list = self.incidents(since, now, 500).unwrap_or_default();
                let html = tg::digest_html(&list, since, now);
                if tg::send(&tgc.bot_token, &tgc.chat_id, &html, None, None).await.is_ok() {
                    let _ = self.storage.set_kv("digest_day", &today);
                    let _ = self.storage.set_kv("digest_at", &now.to_string());
                }
            }
        }
    }

    async fn send_others(&self, s: &Settings, text: &str) {
        let mut ch = s.channels.clone();
        ch.telegram.enabled = false;
        for (chan, err) in alerts::dispatch(&ch, "NetPulse", text).await {
            self.channel_error(&chan, &err);
        }
    }

    fn channel_error(&self, chan: &str, err: &str) {
        let _ = self.storage.insert_event(&EventRecord {
            id: 0,
            ts: now_ms(),
            target_id: None,
            target_name: None,
            kind: "channel_error".into(),
            severity: "warning".into(),
            message: format!("Не удалось отправить в {chan}: {err}"),
        });
    }

    // ------------------------------------------------------------ бот

    /// Долгий опрос бота: кнопки под сообщениями и команды в чате.
    pub(super) async fn bot_loop(self: Arc<Self>) {
        let mut offset: i64 = 0;
        let started = self.started_at / 1000 - 60;
        loop {
            let tgc = self.settings.read().channels.telegram.clone();
            let control = self.settings.read().incident_control;
            if !(control && tgc.enabled && tgc.interactive && !tgc.bot_token.is_empty() && !tgc.chat_id.is_empty()) {
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            }
            match tg::get_updates(&tgc.bot_token, offset, 25).await {
                Ok(list) => {
                    for u in list {
                        if let Some(id) = u.get("update_id").and_then(|v| v.as_i64()) {
                            offset = offset.max(id + 1);
                        }
                        let date = u.pointer("/message/date").or_else(|| u.pointer("/callback_query/message/date")).and_then(|v| v.as_i64()).unwrap_or(0);
                        if u.get("callback_query").is_none() && date < started {
                            continue;
                        }
                        self.handle_update(&tgc, &u).await;
                    }
                }
                Err(e) => {
                    log::warn!("бот: {e}");
                    tokio::time::sleep(Duration::from_secs(15)).await;
                }
            }
        }
    }

    async fn handle_update(self: &Arc<Self>, tgc: &TelegramChannel, u: &serde_json::Value) {
        use serde_json::Value;
        let now = now_ms();
        let same_chat = |chat: Option<&Value>| chat.map(|c| c.to_string().trim_matches('"') == tgc.chat_id.trim()).unwrap_or(false);
        let who = |from: Option<&Value>| -> String {
            let f = from.cloned().unwrap_or(Value::Null);
            let first = f.get("first_name").and_then(Value::as_str).unwrap_or("");
            let last = f.get("last_name").and_then(Value::as_str).unwrap_or("");
            let name = format!("{first} {last}").trim().to_string();
            if name.is_empty() { f.get("username").and_then(Value::as_str).unwrap_or("кто-то").to_string() } else { name }
        };
        if let Some(cb) = u.get("callback_query") {
            let cb_id = cb.get("id").and_then(Value::as_str).unwrap_or("");
            if !same_chat(cb.pointer("/message/chat/id")) {
                let _ = tg::answer_callback(&tgc.bot_token, cb_id, "Этот чат не подключён к NetPulse").await;
                return;
            }
            let by = who(cb.get("from"));
            let data = cb.get("data").and_then(Value::as_str).unwrap_or("");
            let (act, id) = data.split_once(':').unwrap_or((data, ""));
            if id == "demo" {
                let _ = tg::answer_callback(&tgc.bot_token, cb_id, "Это пример — на настоящем инциденте кнопка сработает").await;
                return;
            }
            let reply = match act {
                "ack" => match self.incident_ack(id, Some(&by)) {
                    Ok(i) if i.ack_by.as_deref() == Some(by.as_str()) => format!("Взято: {by}"),
                    Ok(i) => format!("Уже взял {}", i.ack_by.unwrap_or_default()),
                    Err(e) => e.to_string(),
                },
                "mute" => self.incident_mute(id, 60, Some(&by)).map(|_| "Тишина на 1 час".to_string()).unwrap_or_else(|e| e.to_string()),
                "unmute" => self.incident_mute(id, 0, Some(&by)).map(|_| "Тишина снята".to_string()).unwrap_or_else(|e| e.to_string()),
                "tkt" => match self.ticket_draft(Some(id), None, None) {
                    Ok(d) => {
                        let mut text = format!("📋 <b>Заявка оператору</b>{}\n", d.operator_name.map(|n| format!(" · {}", tg::esc(&n))).unwrap_or_default());
                        if let Some(to) = &d.to {
                            text.push_str(&format!("Кому: <code>{}</code>\n", tg::esc(to)));
                        }
                        text.push_str(&format!("Тема: {}\n<pre>{}</pre>", tg::esc(&d.subject), tg::esc(&d.body)));
                        let mid = cb.pointer("/message/message_id").and_then(Value::as_i64);
                        let _ = tg::send(&tgc.bot_token, &tgc.chat_id, &text, None, mid).await;
                        "Текст заявки — в чате".into()
                    }
                    Err(e) => e.to_string(),
                },
                _ => "Неизвестная команда".into(),
            };
            let _ = tg::answer_callback(&tgc.bot_token, cb_id, &reply).await;
            // Сообщение обновляем сразу, не дожидаясь очередного прохода.
            let found = self.incidents.lock().iter().find(|i| i.id == id).cloned();
            if let Some(i) = found {
                if let Some(mid) = i.tg_message_id {
                    let ops = self.incident_operators(&i);
                    let _ = tg::edit(&tgc.bot_token, &tgc.chat_id, mid, &tg::incident_html(&i, &ops, now, true), tg::keyboard(&i, now)).await;
                    self.inc_dirty.lock().remove(id);
                }
            }
            return;
        }
        let Some(m) = u.get("message") else { return };
        if !same_chat(m.pointer("/chat/id")) {
            return;
        }
        let text = m.get("text").and_then(Value::as_str).unwrap_or("").trim();
        if !text.starts_with('/') {
            return;
        }
        let (cmd, arg) = text.split_once(' ').unwrap_or((text, ""));
        let cmd = cmd.split('@').next().unwrap_or(cmd);
        let mid = m.get("message_id").and_then(Value::as_i64);
        let answer = match cmd {
            "/status" => tg::status_html(&self.incidents.lock().clone(), now),
            "/who" => {
                let q = arg.trim().to_lowercase();
                if q.is_empty() {
                    "Напишите, о ком спросить: /who склад или /who 10.0.0.1".into()
                } else {
                    let hit = self.list_targets().into_iter().find(|t| t.name.to_lowercase().contains(&q) || t.host.contains(&q) || t.group.to_lowercase().contains(&q));
                    match hit {
                        Some(t) => tg::who_html(&t.name, &self.target_operators(&t.id)),
                        None => {
                            let ops: Vec<TargetOperator> = self
                                .operators()
                                .into_iter()
                                .filter(|o| o.name.to_lowercase().contains(&q))
                                .map(|o| TargetOperator { operator: o, service: None, via: "name".into() })
                                .collect();
                            tg::who_html(arg.trim(), &ops)
                        }
                    }
                }
            }
            "/help" | "/start" => "NetPulse:\n/status — что сейчас открыто\n/who <i>узел, группа или оператор</i> — кому звонить\nКнопки под сообщением: «Беру», «Тишина 1 ч», «Заявка».".into(),
            _ => return,
        };
        let _ = tg::send(&tgc.bot_token, &tgc.chat_id, &answer, None, mid).await;
    }
}
