//! Инциденты: проблема от первого сигнала до восстановления.
//!
//! Поток отдельных событий («недоступен», «снова доступен», «потери 15%») превращается
//! в небольшое число инцидентов. Узлы одной группы, упавшие почти одновременно, и узлы,
//! чей родитель уже лежит, попадают в один инцидент: одна авария — одна запись и одно
//! сообщение в Телеграме, которое потом обновляется.

use crate::model::{Incident, IncidentLog, IncidentTarget, Target};
use chrono::TimeZone;

/// Узлы одной группы, упавшие в пределах этого окна, — одна авария.
pub const JOIN_WINDOW_MS: i64 = 2 * 60_000;

pub fn is_problem(kind: &str) -> bool {
    matches!(kind, "down" | "loss" | "latency" | "jitter" | "mos")
}

pub fn is_recovery(kind: &str) -> bool {
    matches!(kind, "recovered" | "loss_ok" | "latency_ok" | "jitter_ok" | "mos_ok")
}

/// События, о которых сообщают через инциденты (одно уведомление на аварию),
/// а не каждое отдельно: недоступность, потери, задержка, восстановления.
pub fn handled_by_incidents(kind: &str) -> bool {
    is_problem(kind) || is_recovery(kind) || matches!(kind, "outage" | "warning")
}

pub fn clock(ms: i64) -> String {
    chrono::Local.timestamp_millis_opt(ms).single().map(|d| d.format("%H:%M").to_string()).unwrap_or_default()
}

pub fn day_clock(ms: i64) -> String {
    chrono::Local.timestamp_millis_opt(ms).single().map(|d| d.format("%d.%m %H:%M").to_string()).unwrap_or_default()
}

/// «37 мин», «2 ч 05 мин», «1 д 3 ч».
pub fn duration(ms: i64) -> String {
    let m = (ms.max(0) as f64 / 60_000.0).round() as i64;
    if ms < 60_000 {
        return format!("{} с", (ms.max(0) as f64 / 1000.0).round() as i64);
    }
    if m < 60 {
        return format!("{m} мин");
    }
    let h = m / 60;
    if h < 24 {
        return format!("{h} ч {:02} мин", m % 60);
    }
    format!("{} д {} ч", h / 24, h % 24)
}

fn new_id(now: i64) -> String {
    format!("{now:x}-{}", &uuid::Uuid::new_v4().simple().to_string()[..6])
}

/// Что изменилось после применения события.
#[derive(Debug, Default, Clone)]
pub struct Change {
    /// Инциденты, которые изменились (их нужно сохранить и обновить сообщение).
    pub touched: Vec<String>,
    /// Только что открытые.
    pub opened: Vec<String>,
    /// Только что закрытые.
    pub closed: Vec<String>,
}

impl Change {
    fn touch(&mut self, id: &str) {
        if !self.touched.iter().any(|x| x == id) {
            self.touched.push(id.to_string());
        }
    }
}

fn active(i: &Incident) -> impl Iterator<Item = &IncidentTarget> {
    i.targets.iter().filter(|t| t.until.is_none())
}

pub fn has_active(i: &Incident, target_id: &str) -> bool {
    active(i).any(|t| t.id == target_id)
}

fn display_name(t: &Target) -> String {
    if t.name.is_empty() { t.host.clone() } else { t.name.clone() }
}

/// Заголовок инцидента по его составу.
pub fn retitle(i: &mut Incident) {
    let n = i.targets.len();
    if i.kind == "down" {
        if n <= 1 {
            let name = i.targets.first().map(|t| t.name.as_str()).unwrap_or("Узел");
            i.title = format!("{name}: нет связи");
        } else {
            let g = if i.group.is_empty() { "Несколько узлов".to_string() } else { i.group.clone() };
            i.title = format!("{g}: нет связи · {n} {}", plural(n, "узел", "узла", "узлов"));
        }
    } else {
        let t = i.targets.first();
        let name = t.map(|t| t.name.as_str()).unwrap_or("Узел");
        let p = t.map(|t| t.problem.as_str()).unwrap_or("");
        i.title = if p.is_empty() { format!("{name}: ухудшение связи") } else { format!("{name}: {p}") };
    }
}

pub fn plural(n: usize, one: &str, few: &str, many: &str) -> String {
    let (a, b) = (n % 10, n % 100);
    if a == 1 && b != 11 {
        one.into()
    } else if (2..=4).contains(&a) && !(12..=14).contains(&b) {
        few.into()
    } else {
        many.into()
    }
}

fn push_log(i: &mut Incident, now: i64, text: impl Into<String>) {
    i.log.push(IncidentLog { ts: now, text: text.into() });
    if i.log.len() > 200 {
        i.log.drain(0..i.log.len() - 200);
    }
}

/// Проблема у цели. `ancestor` — недоступный родитель (если цель лежит из-за него).
pub fn on_problem(
    open: &mut Vec<Incident>,
    t: &Target,
    kind: &str,
    problem: &str,
    cause: Option<&str>,
    ancestor: Option<&str>,
    now: i64,
) -> Change {
    let mut ch = Change::default();
    let name = display_name(t);
    if kind == "down" {
        // Ухудшение у этой цели теперь неважно: она лежит целиком.
        for i in open.iter_mut().filter(|i| i.closed.is_none() && i.kind == "degraded") {
            if let Some(x) = i.targets.iter_mut().find(|x| x.id == t.id && x.until.is_none()) {
                x.until = Some(now);
                x.problem = "перешёл в недоступность".into();
                push_log(i, now, format!("{name}: связь пропала полностью"));
                ch.touch(&i.id);
            }
        }
        if let Some(i) = open.iter_mut().find(|i| i.closed.is_none() && i.kind == "down" && has_active(i, &t.id)) {
            if let Some(x) = i.targets.iter_mut().find(|x| x.id == t.id && x.until.is_none()) {
                x.problem = problem.to_string();
            }
            ch.touch(&i.id);
        } else {
            // К какому инциденту присоединить: где лежит родитель, иначе свежая авария той же группы.
            let idx = ancestor
                .and_then(|a| open.iter().position(|i| i.closed.is_none() && i.kind == "down" && has_active(i, a)))
                .or_else(|| {
                    open.iter().position(|i| {
                        i.closed.is_none()
                            && i.kind == "down"
                            && !t.group.is_empty()
                            && i.group == t.group
                            && active(i).count() > 0
                            && i.targets.iter().map(|x| x.since).max().map_or(false, |s| now - s <= JOIN_WINDOW_MS)
                    })
                });
            let entry = IncidentTarget { id: t.id.clone(), name: name.clone(), host: t.host.clone(), since: now, until: None, problem: problem.to_string() };
            match idx {
                Some(k) => {
                    let i = &mut open[k];
                    // Вернувшийся и снова упавший узел — та же строка, а не дубль.
                    if let Some(x) = i.targets.iter_mut().find(|x| x.id == t.id) {
                        x.until = None;
                        x.problem = problem.to_string();
                    } else {
                        i.targets.push(entry);
                    }
                    let why = ancestor.map(|_| " (из-за узла выше)").unwrap_or("");
                    push_log(i, now, format!("{name}: нет связи{why}"));
                    if i.group != t.group {
                        i.group = String::new();
                    }
                    retitle(i);
                    ch.touch(&i.id);
                }
                None => {
                    let mut i = Incident {
                        id: new_id(now),
                        opened: now,
                        severity: "critical".into(),
                        kind: "down".into(),
                        group: t.group.clone(),
                        cause: cause.map(str::to_string),
                        targets: vec![entry],
                        ..Default::default()
                    };
                    push_log(&mut i, now, format!("{name}: нет связи"));
                    retitle(&mut i);
                    ch.opened.push(i.id.clone());
                    ch.touch(&i.id);
                    open.push(i);
                }
            }
        }
    } else {
        // Ухудшение: если цель уже в аварии — новое не заводим.
        if open.iter().any(|i| i.closed.is_none() && i.kind == "down" && has_active(i, &t.id)) {
            return ch;
        }
        if let Some(i) = open.iter_mut().find(|i| i.closed.is_none() && i.kind == "degraded" && has_active(i, &t.id)) {
            if let Some(x) = i.targets.iter_mut().find(|x| x.id == t.id && x.until.is_none()) {
                x.problem = problem.to_string();
            }
            push_log(i, now, format!("{name}: {problem}"));
            retitle(i);
            ch.touch(&i.id);
        } else {
            let mut i = Incident {
                id: new_id(now),
                opened: now,
                severity: "warning".into(),
                kind: "degraded".into(),
                group: t.group.clone(),
                cause: cause.map(str::to_string),
                targets: vec![IncidentTarget { id: t.id.clone(), name: name.clone(), host: t.host.clone(), since: now, until: None, problem: problem.to_string() }],
                ..Default::default()
            };
            push_log(&mut i, now, format!("{name}: {problem}"));
            retitle(&mut i);
            ch.opened.push(i.id.clone());
            ch.touch(&i.id);
            open.push(i);
        }
    }
    close_finished(open, now, &mut ch);
    if let Some(c) = cause {
        for id in &ch.touched {
            if let Some(i) = open.iter_mut().find(|i| &i.id == id) {
                if i.cause.is_none() {
                    i.cause = Some(c.to_string());
                }
            }
        }
    }
    ch
}

/// Восстановление у цели. `still_degraded` — у цели ещё остались другие ухудшения.
pub fn on_recovery(open: &mut [Incident], t: &Target, kind: &str, still_degraded: bool, now: i64) -> Change {
    let mut ch = Change::default();
    let name = display_name(t);
    for i in open.iter_mut().filter(|i| i.closed.is_none()) {
        let hit = match (i.kind.as_str(), kind) {
            ("down", "recovered") => true,
            ("degraded", k) if k != "recovered" => !still_degraded,
            ("degraded", "recovered") => true,
            _ => false,
        };
        if !hit {
            continue;
        }
        if let Some(x) = i.targets.iter_mut().find(|x| x.id == t.id && x.until.is_none()) {
            x.until = Some(now);
            push_log(i, now, format!("{name}: снова в норме"));
            ch.touch(&i.id);
        }
    }
    close_finished(open, now, &mut ch);
    ch
}

/// Закрывает инциденты, у которых не осталось проблемных узлов.
pub fn close_finished(open: &mut [Incident], now: i64, ch: &mut Change) {
    for i in open.iter_mut().filter(|i| i.closed.is_none()) {
        if !i.targets.is_empty() && i.targets.iter().all(|x| x.until.is_some()) {
            i.closed = Some(now);
            push_log(i, now, format!("Закрыт: простой {}", duration(now - i.opened)));
            ch.closed.push(i.id.clone());
            ch.touch(&i.id);
        }
    }
}

/// Принудительно снимает цель из инцидентов (цель удалена или выключена).
pub fn drop_target(open: &mut [Incident], target_id: &str, why: &str, now: i64) -> Change {
    let mut ch = Change::default();
    for i in open.iter_mut().filter(|i| i.closed.is_none()) {
        if let Some(x) = i.targets.iter_mut().find(|x| x.id == target_id && x.until.is_none()) {
            x.until = Some(now);
            x.problem = why.to_string();
            let n = x.name.clone();
            push_log(i, now, format!("{n}: {why}"));
            ch.touch(&i.id);
        }
    }
    close_finished(open, now, &mut ch);
    ch
}

pub fn ack(i: &mut Incident, by: &str, now: i64) -> bool {
    if i.ack_by.is_some() {
        return false;
    }
    let by = if by.trim().is_empty() { "дежурный" } else { by.trim() };
    i.ack_by = Some(by.to_string());
    i.ack_at = Some(now);
    push_log(i, now, format!("Взял в работу: {by}"));
    true
}

pub fn mute(i: &mut Incident, minutes: i64, by: &str, now: i64) {
    if minutes <= 0 {
        i.muted_until = None;
        push_log(i, now, format!("Тишина снята{}", if by.is_empty() { String::new() } else { format!(" ({by})") }));
    } else {
        i.muted_until = Some(now + minutes * 60_000);
        push_log(i, now, format!("Тишина на {} {}", duration(minutes * 60_000), if by.is_empty() { String::new() } else { format!("({by})") }));
    }
}

pub fn log(i: &mut Incident, now: i64, text: impl Into<String>) {
    push_log(i, now, text);
}

/// Сколько длится или длился инцидент.
pub fn length(i: &Incident, now: i64) -> i64 {
    i.closed.unwrap_or(now) - i.opened
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tgt(id: &str, group: &str) -> Target {
        Target { id: id.into(), name: id.to_uppercase(), host: format!("{id}.example"), group: group.into(), ..Default::default() }
    }

    #[test]
    fn site_outage_is_one_incident() {
        let mut open = Vec::new();
        let a = tgt("a", "Склад");
        let b = tgt("b", "Склад");
        let c = tgt("c", "Офис");
        let ch = on_problem(&mut open, &a, "down", "недоступен", Some("обрыв после хопа 4"), None, 1_000);
        assert_eq!(ch.opened.len(), 1);
        on_problem(&mut open, &b, "down", "недоступен", None, None, 30_000);
        on_problem(&mut open, &c, "down", "недоступен", None, None, 31_000);
        assert_eq!(open.len(), 2, "другая группа — отдельный инцидент");
        assert_eq!(open[0].targets.len(), 2);
        assert!(open[0].title.starts_with("Склад: нет связи · 2"));
        assert_eq!(open[0].cause.as_deref(), Some("обрыв после хопа 4"));
        // Позже окна — уже не та же авария.
        let d = tgt("d", "Склад");
        on_problem(&mut open, &d, "down", "недоступен", None, None, 30_000 + JOIN_WINDOW_MS + 1);
        assert_eq!(open.len(), 3);
    }

    #[test]
    fn child_joins_parent_incident() {
        let mut open = Vec::new();
        let p = tgt("p", "Сеть");
        let c = tgt("c", "Касса");
        on_problem(&mut open, &p, "down", "недоступен", None, None, 0);
        on_problem(&mut open, &c, "down", "недоступен", None, Some("p"), 10 * 60_000);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].targets.len(), 2);
        assert!(open[0].group.is_empty());
    }

    #[test]
    fn closes_when_everyone_recovers() {
        let mut open = Vec::new();
        let a = tgt("a", "Склад");
        let b = tgt("b", "Склад");
        on_problem(&mut open, &a, "down", "недоступен", None, None, 0);
        on_problem(&mut open, &b, "down", "недоступен", None, None, 1_000);
        let ch = on_recovery(&mut open, &a, "recovered", false, 60_000);
        assert!(ch.closed.is_empty());
        let ch = on_recovery(&mut open, &b, "recovered", false, 120_000);
        assert_eq!(ch.closed.len(), 1);
        assert_eq!(open[0].closed, Some(120_000));
    }

    #[test]
    fn degraded_then_down_and_back() {
        let mut open = Vec::new();
        let a = tgt("a", "Офис");
        on_problem(&mut open, &a, "loss", "потери 15%", None, None, 0);
        assert_eq!(open[0].kind, "degraded");
        on_problem(&mut open, &a, "latency", "задержка 180 мс", None, None, 5_000);
        assert_eq!(open.len(), 1);
        on_problem(&mut open, &a, "down", "недоступен", None, None, 10_000);
        assert_eq!(open.len(), 2);
        assert_eq!(open[0].closed, Some(10_000), "ухудшение закрыто — узел лежит целиком");
        // Ещё есть задержка — по loss_ok не закрываем.
        let mut open2 = Vec::new();
        on_problem(&mut open2, &a, "loss", "потери 15%", None, None, 0);
        on_recovery(&mut open2, &a, "loss_ok", true, 1_000);
        assert!(open2[0].closed.is_none());
        on_recovery(&mut open2, &a, "latency_ok", false, 2_000);
        assert!(open2[0].closed.is_some());
    }

    #[test]
    fn durations() {
        assert_eq!(duration(30_000), "30 с");
        assert_eq!(duration(37 * 60_000), "37 мин");
        assert_eq!(duration(125 * 60_000), "2 ч 05 мин");
        assert_eq!(plural(21, "узел", "узла", "узлов"), "узел");
        assert_eq!(plural(12, "узел", "узла", "узлов"), "узлов");
    }
}
