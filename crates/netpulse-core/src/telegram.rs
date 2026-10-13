//! Телеграм-бот: одно сообщение на инцидент, которое обновляется по ходу дела,
//! кнопки «Беру», «Тишина», «Заявка» и команды /status, /who.

use crate::incidents::{clock, day_clock, duration, plural};
use crate::model::{Incident, TargetOperator};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // Долгий опрос getUpdates держит соединение до 25 секунд.
                .timeout(std::time::Duration::from_secs(40))
                .user_agent(concat!("NetPulse/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

async fn call(token: &str, method: &str, body: Value) -> Result<Value> {
    if token.is_empty() {
        return Err(anyhow!("не указан токен бота"));
    }
    let resp = client().post(format!("https://api.telegram.org/bot{token}/{method}")).json(&body).send().await?;
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if v.get("ok").and_then(Value::as_bool) != Some(true) {
        let d = v.get("description").and_then(Value::as_str).unwrap_or("нет ответа");
        return Err(anyhow!("Telegram: {d}"));
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

/// Экранирование для parse_mode=HTML.
pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub async fn send(token: &str, chat: &str, html: &str, keyboard: Option<Value>, reply_to: Option<i64>) -> Result<i64> {
    let mut body = json!({ "chat_id": chat, "text": html, "parse_mode": "HTML", "disable_web_page_preview": true });
    if let Some(k) = keyboard {
        body["reply_markup"] = k;
    }
    if let Some(r) = reply_to {
        body["reply_parameters"] = json!({ "message_id": r, "allow_sending_without_reply": true });
    }
    let r = call(token, "sendMessage", body).await?;
    Ok(r.get("message_id").and_then(Value::as_i64).unwrap_or(0))
}

pub async fn edit(token: &str, chat: &str, message_id: i64, html: &str, keyboard: Option<Value>) -> Result<()> {
    let body = json!({
        "chat_id": chat,
        "message_id": message_id,
        "text": html,
        "parse_mode": "HTML",
        "disable_web_page_preview": true,
        "reply_markup": keyboard.unwrap_or_else(|| json!({ "inline_keyboard": [] })),
    });
    match call(token, "editMessageText", body).await {
        Err(e) if e.to_string().contains("not modified") => Ok(()),
        r => r.map(|_| ()),
    }
}

pub async fn answer_callback(token: &str, id: &str, text: &str) -> Result<()> {
    call(token, "answerCallbackQuery", json!({ "callback_query_id": id, "text": text })).await.map(|_| ())
}

pub async fn get_updates(token: &str, offset: i64, timeout: u32) -> Result<Vec<Value>> {
    let r = call(token, "getUpdates", json!({ "offset": offset, "timeout": timeout, "allowed_updates": ["message", "callback_query"] })).await?;
    Ok(r.as_array().cloned().unwrap_or_default())
}

/// Кнопки под сообщением инцидента.
pub fn keyboard(i: &Incident, now: i64) -> Option<Value> {
    if i.closed.is_some() {
        return None;
    }
    let mut row = Vec::new();
    if i.ack_by.is_none() {
        row.push(json!({ "text": "✋ Беру", "callback_data": format!("ack:{}", i.id) }));
    }
    if i.muted_until.map_or(false, |m| m > now) {
        row.push(json!({ "text": "🔔 Снять тишину", "callback_data": format!("unmute:{}", i.id) }));
    } else {
        row.push(json!({ "text": "🔕 Тишина 1 ч", "callback_data": format!("mute:{}", i.id) }));
    }
    row.push(json!({ "text": "📋 Заявка", "callback_data": format!("tkt:{}", i.id) }));
    Some(json!({ "inline_keyboard": [row] }))
}

/// Короткая строка «кому звонить».
pub fn contact_line(ops: &[TargetOperator]) -> Option<String> {
    let o = ops.first()?;
    let mut parts = vec![format!("<b>{}</b>", esc(&o.operator.name))];
    if let Some(p) = o.operator.phones.first() {
        parts.push(format!("<code>{}</code>", esc(&p.value)));
    } else if let Some(e) = o.operator.emails.first() {
        parts.push(format!("<code>{}</code>", esc(&e.value)));
    }
    let mut line = format!("📞 {}", parts.join(" · "));
    let mut svc = Vec::new();
    if let Some(s) = &o.service {
        if !s.number.is_empty() {
            svc.push(format!("услуга <code>{}</code>", esc(&s.number)));
        }
    }
    if !o.operator.contract.is_empty() {
        svc.push(format!("дог. {}", esc(&o.operator.contract)));
    }
    if !svc.is_empty() {
        line.push_str(&format!("\n{}", svc.join(" · ")));
    }
    Some(line)
}

/// Строка узла в сообщении: имя, адрес и что с ним.
fn target_line(t: &crate::model::IncidentTarget, kind: &str, closed: bool) -> String {
    let host = if t.host.is_empty() || t.host == t.name { String::new() } else { format!(" <code>{}</code>", esc(&t.host)) };
    let state = match t.until {
        Some(u) if !closed => format!(" — ✓ в норме с {}", clock(u)),
        _ if kind == "down" || t.problem.is_empty() => String::new(),
        _ => format!(" — {}", esc(&t.problem)),
    };
    format!("{}{host}{state}", esc(&t.name))
}

/// Текст сообщения об инциденте: открытого или уже закрытого.
pub fn incident_html(i: &Incident, ops: &[TargetOperator], now: i64, control: bool) -> String {
    let mut out = Vec::new();
    let closed = i.closed.is_some();
    let icon = if closed { "✅" } else if i.severity == "critical" { "🔴" } else { "🟠" };
    let group = if i.group.is_empty() { String::new() } else { format!("{} · ", esc(&i.group)) };
    let at = |ms: i64| if now - ms > 20 * 3_600_000 { day_clock(ms) } else { clock(ms) };
    if closed {
        let end = i.closed.unwrap_or(now);
        out.push(format!("{icon} <b>Восстановлено</b> · <s>{}</s>", esc(&i.title)));
        out.push(format!("{group}{}–{} · простой <b>{}</b>", at(i.opened), clock(end), duration(end - i.opened)));
    } else {
        out.push(format!("{icon} <b>{}</b>", esc(&i.title)));
        out.push(format!("{group}с {}", at(i.opened)));
    }
    // Узлы: один — строкой с адресом, несколько — списком (живые сверху).
    if i.targets.len() == 1 {
        out.push(target_line(&i.targets[0], &i.kind, closed));
    } else if !i.targets.is_empty() {
        let mut list: Vec<&crate::model::IncidentTarget> = i.targets.iter().collect();
        list.sort_by_key(|t| t.until.is_some());
        out.push(String::new());
        for t in list.iter().take(10) {
            out.push(format!("• {}", target_line(t, &i.kind, closed)));
        }
        if list.len() > 10 {
            out.push(format!("• … и ещё {}", list.len() - 10));
        }
    }
    if let Some(c) = &i.cause {
        out.push(format!("Причина: <i>{}</i>", esc(c)));
    }
    if !closed {
        if let Some(c) = contact_line(ops) {
            out.push(String::new());
            out.push(c);
        }
    }
    let mut status = Vec::new();
    if let (Some(by), Some(at)) = (&i.ack_by, i.ack_at) {
        status.push(format!("✋ Взял: <b>{}</b> в {}", esc(by), clock(at)));
    } else if !closed && control {
        status.push("⚠️ Никто не взял в работу".to_string());
    }
    if let Some(t) = &i.ticket {
        let num = if t.number.is_empty() { "без номера".to_string() } else { format!("№ <code>{}</code>", esc(&t.number)) };
        status.push(format!("📝 Заявка {} · {} · {}", num, esc(&t.operator_name), clock(t.at)));
    }
    if !closed && i.muted_until.map_or(false, |m| m > now) {
        status.push(format!("🔕 Тишина до {}", clock(i.muted_until.unwrap_or(now))));
    }
    if !status.is_empty() {
        out.push(String::new());
        out.extend(status);
    }
    out.join("\n")
}

/// Заголовок и текст системного уведомления (macOS/Windows) по инциденту.
/// `event`: open | close | remind.
pub fn notice_text(i: &Incident, ops: &[TargetOperator], now: i64, event: &str) -> (String, String) {
    let icon = if i.severity == "critical" { "🔴" } else { "🟠" };
    let title = match event {
        "close" => format!("✅ Восстановлено: {}", i.title),
        "remind" => format!("⏱ Никто не взял: {}", i.title),
        _ => format!("{icon} {}", i.title),
    };
    let mut lines = Vec::new();
    let names: Vec<String> = i
        .targets
        .iter()
        .map(|t| if i.targets.len() == 1 && !t.host.is_empty() && t.host != t.name { format!("{} · {}", t.host, if i.kind == "down" { "нет ответа".to_string() } else { t.problem.clone() }) } else { t.name.clone() })
        .collect();
    let shown = names.iter().take(4).cloned().collect::<Vec<_>>().join(", ");
    let more = names.len().saturating_sub(4);
    lines.push(if more > 0 { format!("{shown} и ещё {more}") } else { shown });
    match event {
        "close" => lines.push(format!("Простой {} · {}–{}", duration(i.closed.unwrap_or(now) - i.opened), clock(i.opened), clock(i.closed.unwrap_or(now)))),
        "remind" => lines.push(format!("Длится {} · с {}", duration(now - i.opened), clock(i.opened))),
        _ => {
            if let Some(c) = &i.cause {
                lines.push(c.clone());
            }
            if let Some(o) = ops.first() {
                let phone = o.operator.phones.first().map(|p| format!(" · {}", p.value)).unwrap_or_default();
                lines.push(format!("Звонить: {}{phone}", o.operator.name));
            }
        }
    }
    (title, lines.join("\n"))
}

/// Ответ на /status.
pub fn status_html(open: &[Incident], now: i64) -> String {
    let open: Vec<&Incident> = open.iter().filter(|i| i.closed.is_none()).collect();
    if open.is_empty() {
        return "✅ Сейчас всё в порядке: открытых инцидентов нет.".into();
    }
    let mut out = vec![format!("<b>Открыто {} {}</b>", open.len(), plural(open.len(), "инцидент", "инцидента", "инцидентов"))];
    for i in open {
        let icon = if i.severity == "critical" { "🔴" } else { "🟠" };
        let who = i.ack_by.as_ref().map(|b| format!(" · взял {}", esc(b))).unwrap_or_else(|| " · никто не взял".into());
        out.push(format!("{icon} {} — {}{who}", esc(&i.title), duration(now - i.opened)));
    }
    out.join("\n")
}

/// Ответ на /who: контакты оператора.
pub fn who_html(what: &str, ops: &[TargetOperator]) -> String {
    if ops.is_empty() {
        return format!("Для «{}» оператор не указан. Его можно назначить в NetPulse → Операторы.", esc(what));
    }
    let mut out = vec![format!("Кому звонить по «{}»:", esc(what))];
    for o in ops.iter().take(3) {
        let op = &o.operator;
        out.push(String::new());
        let role = match o.service.as_ref().map(|s| s.role.as_str()) {
            Some("backup") => " · резервный",
            _ => "",
        };
        out.push(format!("<b>{}</b>{role}", esc(&op.name)));
        for p in &op.phones {
            out.push(format!("📞 <code>{}</code> {}", esc(&p.value), esc(&p.label)));
        }
        for e in &op.emails {
            out.push(format!("✉️ <code>{}</code> {}", esc(&e.value), esc(&e.label)));
        }
        if !op.portal.is_empty() {
            out.push(format!("🌐 {}", esc(&op.portal)));
        }
        if let Some(s) = &o.service {
            if !s.number.is_empty() {
                out.push(format!("Услуга: <code>{}</code>", esc(&s.number)));
            }
            if !s.address.is_empty() {
                out.push(format!("Адрес: {}", esc(&s.address)));
            }
        }
        if !op.contract.is_empty() {
            out.push(format!("Договор: {}", esc(&op.contract)));
        }
    }
    out.join("\n")
}

/// Утренняя сводка: что было с прошлой сводки и что ещё открыто.
pub fn digest_html(list: &[Incident], since: i64, now: i64) -> String {
    let done: Vec<&Incident> = list.iter().filter(|i| i.closed.is_some() && i.opened >= since).collect();
    let open: Vec<&Incident> = list.iter().filter(|i| i.closed.is_none()).collect();
    let mut out = vec![format!("☀️ <b>Сводка NetPulse</b> · с {}", day_clock(since))];
    if done.is_empty() && open.is_empty() {
        out.push("Всё было в порядке, инцидентов не было.".into());
        return out.join("\n");
    }
    if !done.is_empty() {
        let total: i64 = done.iter().map(|i| i.closed.unwrap_or(now) - i.opened).sum();
        out.push(format!("Было {} {} · простой суммарно {}", done.len(), plural(done.len(), "инцидент", "инцидента", "инцидентов"), duration(total)));
        for i in done.iter().take(12) {
            out.push(format!("• {} — {} ({}–{})", esc(&i.title), duration(i.closed.unwrap_or(now) - i.opened), clock(i.opened), clock(i.closed.unwrap_or(now))));
        }
    }
    if !open.is_empty() {
        out.push(String::new());
        out.push(format!("<b>Открыто сейчас: {}</b>", open.len()));
        for i in open.iter().take(12) {
            out.push(format!("• {} — {}", esc(&i.title), duration(now - i.opened)));
        }
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Contact, IncidentTarget, Operator, OperatorService};

    #[test]
    fn renders_open_and_closed() {
        let mut i = Incident {
            id: "x".into(),
            opened: 0,
            severity: "critical".into(),
            kind: "down".into(),
            group: "Склад".into(),
            title: "Склад: нет связи · 2 узла".into(),
            cause: Some("обрыв после хопа 4 <оператор>".into()),
            targets: vec![
                IncidentTarget { id: "a".into(), name: "A".into(), host: "10.0.0.1".into(), ..Default::default() },
                IncidentTarget { id: "b".into(), name: "B".into(), host: "10.0.0.2".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        let ops = vec![TargetOperator {
            operator: Operator { name: "Пример-Телеком".into(), phones: vec![Contact { value: "8 800 000-00-00".into(), label: "".into() }], contract: "15/2023".into(), ..Default::default() },
            service: Some(OperatorService { number: "0471-22".into(), ..Default::default() }),
            via: "group".into(),
        }];
        let h = incident_html(&i, &ops, 60_000, true);
        assert!(h.contains("🔴 <b>Склад: нет связи · 2 узла</b>"));
        assert!(h.contains("&lt;оператор&gt;"));
        assert!(h.contains("8 800 000-00-00"));
        assert!(h.contains("0471-22"));
        assert!(keyboard(&i, 0).is_some());
        i.closed = Some(37 * 60_000);
        i.ack_by = Some("Андрей".into());
        i.ack_at = Some(60_000);
        let h = incident_html(&i, &ops, 40 * 60_000, true);
        assert!(h.starts_with("✅ <b>Восстановлено</b>"));
        assert!(h.contains("простой <b>37 мин</b>"));
        assert!(h.contains("Взял: <b>Андрей</b>"));
        assert!(keyboard(&i, 0).is_none());
    }
}
