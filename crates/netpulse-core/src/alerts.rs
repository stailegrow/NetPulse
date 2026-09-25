use crate::model::{AlertRules, CheckKind, Channels, Sample, SmtpSecurity, Target, WebhookFormat};
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::VecDeque;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub target_id: String,
    pub target_name: String,
    /// down | recovered | loss | loss_ok | latency | latency_ok | route | cert | dns
    pub kind: String,
    /// critical | warning | info | ok
    pub severity: String,
    pub message: String,
    /// Отправлять ли во внешние каналы и системные уведомления.
    pub notify: bool,
    /// Режим тишины у цели: событие пишется в журнал, но без всплывающих окон, звука и счётчика.
    #[serde(default)]
    pub silent: bool,
}

#[derive(Default, Debug)]
pub struct AlertState {
    pub down: bool,
    pub loss: bool,
    pub latency: bool,
    pub jitter: bool,
    pub mos: bool,
    last_notified: i64,
    cert_notified_day: i64,
}

fn alert(t: &Target, kind: &str, severity: &str, message: String) -> Alert {
    Alert {
        target_id: t.id.clone(),
        target_name: t.name.clone(),
        kind: kind.into(),
        severity: severity.into(),
        message,
        notify: t.alerts_enabled,
        silent: !t.alerts_enabled,
    }
}

fn label(t: &Target) -> String {
    if t.name.is_empty() || t.name == t.host {
        t.host.clone()
    } else {
        format!("{} ({})", t.name, t.host)
    }
}

/// Оценивает правила алертов после нового сэмпла.
pub fn evaluate(st: &mut AlertState, t: &Target, rules: &AlertRules, recent: &VecDeque<Sample>, now: i64) -> Vec<Alert> {
    let mut out = Vec::new();
    let Some(last) = recent.back() else { return out };
    let name = label(t);

    // --- Недоступность
    let n = rules.down_after_samples.max(1) as usize;
    let all_lost = recent.len() >= n && recent.iter().rev().take(n).all(|s| s.rtt_ms.is_none());
    let up_n = (n / 2).clamp(2, 4).min(recent.len());
    if all_lost && !st.down {
        st.down = true;
        st.loss = false;
        st.latency = false;
        st.jitter = false;
        st.mos = false;
        st.last_notified = now;
        let why = last.error.clone().unwrap_or_else(|| "нет ответа".into());
        out.push(alert(t, "down", "critical", format!("🔴 {name} недоступен: {why}")));
    } else if st.down && recent.len() >= 2 && recent.iter().rev().take(up_n).all(|s| s.rtt_ms.is_some()) {
        // Восстановление подтверждаем несколькими ответами подряд, иначе на «дребезжащем»
        // канале пойдёт поток «недоступен / снова доступен».
        st.down = false;
        st.last_notified = now;
        if rules.notify_recovery {
            let rtt = last.rtt_ms.unwrap_or_default();
            out.push(alert(t, "recovered", "ok", format!("🟢 {name} снова доступен ({rtt:.0} мс)")));
        }
    }

    // --- Потери и задержка по окну
    if !st.down {
        let w = rules.window_samples.max(2) as usize;
        let window: Vec<&Sample> = recent.iter().rev().take(w).collect();
        if window.len() >= w.min(4) {
            let lost = window.iter().filter(|s| s.rtt_ms.is_none()).count();
            let loss = lost as f64 * 100.0 / window.len() as f64;
            if rules.loss_enabled {
                if !st.loss && loss > t.thresholds.bad_loss && window.len() >= w {
                    st.loss = true;
                    st.last_notified = now;
                    out.push(alert(t, "loss", "warning", format!("🟠 {name}: потери пакетов {loss:.0}%")));
                } else if st.loss && loss <= t.thresholds.warn_loss {
                    st.loss = false;
                    st.last_notified = now;
                    if rules.notify_recovery {
                        out.push(alert(t, "loss_ok", "ok", format!("🟢 {name}: потери в норме ({loss:.0}%)")));
                    }
                }
            }
            let ok: Vec<f32> = window.iter().filter_map(|s| s.rtt_ms).collect();
            if rules.latency_enabled && t.kind != CheckKind::Http && !ok.is_empty() {
                let avg = ok.iter().sum::<f32>() as f64 / ok.len() as f64;
                if !st.latency && avg > t.thresholds.crit_ms && window.len() >= w {
                    st.latency = true;
                    st.last_notified = now;
                    out.push(alert(t, "latency", "warning", format!("🟠 {name}: высокая задержка {avg:.0} мс")));
                } else if st.latency && avg <= t.thresholds.crit_ms * 0.8 {
                    st.latency = false;
                    if rules.notify_recovery {
                        out.push(alert(t, "latency_ok", "ok", format!("🟢 {name}: задержка в норме ({avg:.0} мс)")));
                    }
                }
            }
            // --- Качество связи для телефонии: jitter и MOS (включаются порогами цели).
            if rules.latency_enabled && t.kind != CheckKind::Http && ok.len() >= 2 {
                let th = &t.thresholds;
                // окно в хронологическом порядке
                let seq: Vec<f32> = window.iter().rev().filter_map(|s| s.rtt_ms).collect();
                let jitter = seq.windows(2).map(|w| (w[1] - w[0]).abs() as f64).sum::<f64>() / (seq.len() - 1) as f64;
                let avg = seq.iter().sum::<f32>() / seq.len() as f32;
                let mos = crate::stats::mos(avg, jitter as f32, loss as f32) as f64;
                if th.jitter_crit > 0.0 {
                    if !st.jitter && jitter > th.jitter_crit && window.len() >= w {
                        st.jitter = true;
                        st.last_notified = now;
                        out.push(alert(t, "jitter", "warning", format!("🟠 {name}: высокий jitter {jitter:.0} мс")));
                    } else if st.jitter && jitter <= th.jitter_crit * 0.8 {
                        st.jitter = false;
                        st.last_notified = now;
                        if rules.notify_recovery {
                            out.push(alert(t, "jitter_ok", "ok", format!("🟢 {name}: jitter в норме ({jitter:.0} мс)")));
                        }
                    }
                }
                if th.mos_crit > 0.0 {
                    if !st.mos && mos < th.mos_crit && window.len() >= w {
                        st.mos = true;
                        st.last_notified = now;
                        out.push(alert(t, "mos", "warning", format!("🟠 {name}: низкое качество связи, MOS {mos:.2}")));
                    } else if st.mos && mos >= th.mos_crit + 0.1 {
                        st.mos = false;
                        st.last_notified = now;
                        if rules.notify_recovery {
                            out.push(alert(t, "mos_ok", "ok", format!("🟢 {name}: качество связи восстановилось, MOS {mos:.2}")));
                        }
                    }
                }
            }
        }
    }

    // --- Повтор незакрытой проблемы
    if rules.repeat_minutes > 0
        && (st.down || st.loss || st.latency || st.jitter || st.mos)
        && out.is_empty()
        && now - st.last_notified >= rules.repeat_minutes as i64 * 60_000
    {
        st.last_notified = now;
        let what = if st.down {
            "всё ещё недоступен"
        } else if st.loss {
            "потери продолжаются"
        } else if st.latency {
            "задержка всё ещё высокая"
        } else {
            "качество связи всё ещё низкое"
        };
        out.push(alert(t, if st.down { "down" } else { "warning" }, if st.down { "critical" } else { "warning" }, format!("⏱ {name}: {what}")));
    }
    out
}

pub fn evaluate_cert(st: &mut AlertState, t: &Target, rules: &AlertRules, days: i64, now: i64) -> Option<Alert> {
    let day = now / 86_400_000;
    if rules.cert_days == 0 || days > rules.cert_days as i64 || st.cert_notified_day == day {
        return None;
    }
    st.cert_notified_day = day;
    let name = label(t);
    Some(if days < 0 {
        alert(t, "cert", "critical", format!("🔴 {name}: SSL-сертификат истёк"))
    } else {
        alert(t, "cert", "warning", format!("🟠 {name}: SSL-сертификат истекает через {days} дн."))
    })
}

// ---------------------------------------------------------------- Каналы доставки

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .user_agent(concat!("NetPulse/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

pub async fn send_telegram(token: &str, chat_id: &str, text: &str) -> Result<()> {
    if token.is_empty() || chat_id.is_empty() {
        return Err(anyhow!("не заполнены токен бота или chat_id"));
    }
    let resp = client()
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .json(&serde_json::json!({ "chat_id": chat_id, "text": text, "disable_web_page_preview": true }))
        .send()
        .await?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Telegram ответил ошибкой: {body}"));
    }
    Ok(())
}

pub async fn send_webhook(url: &str, format: WebhookFormat, title: &str, text: &str) -> Result<()> {
    if url.is_empty() {
        return Err(anyhow!("не указан URL вебхука"));
    }
    let body = match format {
        WebhookFormat::Slack => serde_json::json!({ "text": format!("*{title}*\n{text}") }),
        WebhookFormat::Discord => serde_json::json!({ "content": format!("**{title}**\n{text}") }),
        WebhookFormat::Generic => serde_json::json!({ "app": "NetPulse", "title": title, "message": text, "ts": crate::checks::now_ms() }),
    };
    let resp = client().post(url).json(&body).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("вебхук ответил кодом {}", resp.status()));
    }
    Ok(())
}

pub async fn send_email(ch: &crate::model::EmailChannel, subject: &str, text: &str) -> Result<()> {
    use lettre::message::header::ContentType;
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

    if ch.host.is_empty() || ch.from.is_empty() || ch.to.is_empty() {
        return Err(anyhow!("не заполнены SMTP-сервер, отправитель или получатели"));
    }
    let mut builder = Message::builder().from(ch.from.parse()?).subject(subject);
    for to in ch.to.split([',', ';']).map(str::trim).filter(|s| !s.is_empty()) {
        builder = builder.to(to.parse()?);
    }
    let msg = builder.header(ContentType::TEXT_PLAIN).body(text.to_string())?;
    let mut tr = match ch.security {
        SmtpSecurity::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&ch.host)?,
        SmtpSecurity::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&ch.host)?,
        SmtpSecurity::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&ch.host),
    }
    .port(ch.port)
    .timeout(Some(std::time::Duration::from_secs(20)));
    if !ch.username.is_empty() {
        tr = tr.credentials(Credentials::new(ch.username.clone(), ch.password.clone()));
    }
    tr.build().send(msg).await?;
    Ok(())
}

/// Рассылка во все включённые внешние каналы. Возвращает ошибки по каналам.
pub async fn dispatch(channels: &Channels, title: &str, text: &str) -> Vec<(String, String)> {
    let mut errors = Vec::new();
    if channels.telegram.enabled {
        if let Err(e) = send_telegram(&channels.telegram.bot_token, &channels.telegram.chat_id, &format!("{title}\n{text}")).await {
            errors.push(("telegram".into(), e.to_string()));
        }
    }
    if channels.webhook.enabled {
        if let Err(e) = send_webhook(&channels.webhook.url, channels.webhook.format, title, text).await {
            errors.push(("webhook".into(), e.to_string()));
        }
    }
    if channels.email.enabled {
        if let Err(e) = send_email(&channels.email, title, text).await {
            errors.push(("email".into(), e.to_string()));
        }
    }
    errors
}

/// Тестовая отправка в конкретный канал (даже если он выключен).
pub async fn test_channel(channels: &Channels, name: &str) -> Result<()> {
    let title = "NetPulse — тестовое уведомление";
    let text = "Если вы видите это сообщение, канал настроен правильно ✅";
    match name {
        "telegram" => send_telegram(&channels.telegram.bot_token, &channels.telegram.chat_id, &format!("{title}\n{text}")).await,
        "webhook" => send_webhook(&channels.webhook.url, channels.webhook.format, title, text).await,
        "email" => send_email(&channels.email, title, text).await,
        other => Err(anyhow!("неизвестный канал {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn smp(rtt: Option<f32>) -> Sample {
        Sample { ts: 0, rtt_ms: rtt, status_code: None, error: None, hops: vec![] }
    }

    #[test]
    fn down_and_recover() {
        let t = Target { id: "a".into(), name: "A".into(), host: "a".into(), ..Default::default() };
        let rules = AlertRules::default();
        let mut st = AlertState::default();
        let mut q = VecDeque::new();
        for _ in 0..3 {
            q.push_back(smp(Some(10.0)));
            assert!(evaluate(&mut st, &t, &rules, &q, 0).is_empty());
        }
        let mut fired = vec![];
        for _ in 0..4 {
            q.push_back(smp(None));
            fired.extend(evaluate(&mut st, &t, &rules, &q, 0));
        }
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].kind, "down");
        // Один ответ не закрывает аварию: нужен подтверждённый ряд.
        q.push_back(smp(Some(12.0)));
        assert!(evaluate(&mut st, &t, &rules, &q, 1).is_empty());
        q.push_back(smp(Some(12.0)));
        let r = evaluate(&mut st, &t, &rules, &q, 2);
        assert_eq!(r[0].kind, "recovered");
    }

    #[test]
    fn latency_alert() {
        let t = Target { id: "a".into(), name: "A".into(), host: "a".into(), ..Default::default() };
        let rules = AlertRules { window_samples: 5, ..Default::default() };
        let mut st = AlertState::default();
        let mut q = VecDeque::new();
        let mut kinds = vec![];
        for _ in 0..5 {
            q.push_back(smp(Some(400.0)));
            kinds.extend(evaluate(&mut st, &t, &rules, &q, 0).into_iter().map(|a| a.kind));
        }
        assert_eq!(kinds, vec!["latency"]);
    }
}
