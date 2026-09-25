use crate::model::{HopSample, HttpOptions, Sample, Target};
use anyhow::{anyhow, Context, Result};
use futures::future::join_all;
use netpulse_icmp::{Pinger, ReplyKind};
use std::net::IpAddr;
use std::time::{Duration, Instant};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn ms(d: Duration) -> f32 {
    d.as_secs_f64() as f32 * 1000.0
}

/// Резолв имени в IP (предпочитаем IPv4).
pub async fn resolve(host: &str) -> Result<IpAddr> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }
    let addrs: Vec<_> = tokio::net::lookup_host((host, 0))
        .await
        .with_context(|| format!("не удалось разрешить имя {host}"))?
        .map(|a| a.ip())
        .collect();
    addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or(addrs.first())
        .copied()
        .ok_or_else(|| anyhow!("DNS не вернул адресов для {host}"))
}

pub async fn reverse_dns(ip: IpAddr) -> Option<String> {
    tokio::task::spawn_blocking(move || dns_lookup::lookup_addr(&ip).ok())
        .await
        .ok()
        .flatten()
        .filter(|n| n.parse::<IpAddr>().is_err())
}

pub struct TraceRound {
    pub hops: Vec<HopSample>,
    pub dest_rtt: Option<f32>,
    /// TTL, на котором ответила цель.
    pub reached_ttl: Option<u8>,
    /// На последнем отправленном TTL получен Time Exceeded — маршрут длиннее.
    pub needs_more: bool,
}

/// Один раунд трассировки: параллельно шлём пробы с TTL 1..=max_ttl.
pub async fn trace_round(pinger: &Pinger, dst: IpAddr, max_ttl: u8, size: u16, timeout: Duration) -> TraceRound {
    let futs = (1..=max_ttl).map(|ttl| {
        let p = pinger.clone();
        async move { (ttl, p.probe(dst, ttl, size, timeout).await.ok().flatten()) }
    });
    let results = join_all(futs).await;
    let mut hops = Vec::with_capacity(results.len());
    let mut reached = None;
    let mut dest_rtt = None;
    for (ttl, r) in &results {
        match r {
            Some(rep) if rep.kind == ReplyKind::Echo || (rep.kind == ReplyKind::Unreachable && rep.from == dst) => {
                hops.push(HopSample { ttl: *ttl, addr: Some(rep.from), rtt_ms: Some(ms(rep.rtt)) });
                reached = Some(*ttl);
                dest_rtt = Some(ms(rep.rtt));
                break;
            }
            Some(rep) => hops.push(HopSample { ttl: *ttl, addr: Some(rep.from), rtt_ms: Some(ms(rep.rtt)) }),
            None => hops.push(HopSample { ttl: *ttl, addr: None, rtt_ms: None }),
        }
    }
    // Если цель не ответила — отрезаем хвост из сплошных таймаутов, оставляя один.
    if reached.is_none() {
        while hops.len() > 1 && hops.last().map_or(false, |h| h.addr.is_none())
            && hops[hops.len() - 2].addr.is_none()
        {
            hops.pop();
        }
    }
    let needs_more = reached.is_none()
        && results.last().map_or(false, |(_, r)| matches!(r, Some(rep) if rep.kind == ReplyKind::TimeExceeded));
    TraceRound { hops, dest_rtt, reached_ttl: reached, needs_more }
}

/// Человеческое описание ответа «недоступен» с кодом ICMP.
pub fn unreachable_text(from: std::net::IpAddr, why: Option<netpulse_icmp::Unreachable>) -> String {
    use netpulse_icmp::Unreachable as U;
    match why {
        Some(U::Network) => format!("нет маршрута до сети (ответ маршрутизатора {from})"),
        Some(U::Host) => format!("узел не отвечает в своей сети, нет ARP (ответ маршрутизатора {from})"),
        Some(U::Protocol) => format!("протокол не поддерживается узлом (ответ {from})"),
        Some(U::Port) => format!("порт закрыт (ответ {from})"),
        Some(U::FragmentationNeeded) => format!("пакет больше MTU, фрагментация запрещена (ответ {from})"),
        Some(U::Prohibited) => format!("запрещено административно: фильтр или ACL (ответ маршрутизатора {from})"),
        Some(U::Other(c)) => format!("узел недоступен, код ICMP {c} (ответ маршрутизатора {from})"),
        None => format!("узел недоступен (ответ маршрутизатора {from})"),
    }
}

pub async fn ping_once(pinger: &Pinger, dst: IpAddr, size: u16, timeout: Duration) -> Sample {
    let ts = now_ms();
    match pinger.probe(dst, 64, size, timeout).await {
        Ok(Some(r)) if r.kind == ReplyKind::Echo => {
            Sample { ts, rtt_ms: Some(ms(r.rtt)), status_code: None, error: None, hops: vec![] }
        }
        Ok(Some(r)) => Sample {
            ts,
            rtt_ms: None,
            status_code: None,
            error: Some(match r.kind {
                ReplyKind::Unreachable => unreachable_text(r.from, r.unreachable),
                _ => format!("TTL истёк на {} (петля маршрутизации или слишком длинный путь)", r.from),
            }),
            hops: vec![],
        },
        Ok(None) => Sample { ts, rtt_ms: None, status_code: None, error: Some("таймаут".into()), hops: vec![] },
        Err(e) => Sample { ts, rtt_ms: None, status_code: None, error: Some(e.to_string()), hops: vec![] },
    }
}

pub fn http_client(opts: &HttpOptions, timeout: Duration) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(timeout)
        .danger_accept_invalid_certs(!opts.verify_tls)
        .redirect(if opts.follow_redirects {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        })
        .user_agent(concat!("NetPulse/", env!("CARGO_PKG_VERSION")))
        .pool_max_idle_per_host(0) // каждый раз честное новое соединение
        .build()?)
}

pub fn normalize_url(host: &str) -> String {
    let h = host.trim();
    if h.starts_with("http://") || h.starts_with("https://") {
        h.to_string()
    } else {
        format!("https://{h}")
    }
}

pub async fn http_check(client: &reqwest::Client, t: &Target) -> Sample {
    let ts = now_ms();
    let url = normalize_url(&t.host);
    let method = reqwest::Method::from_bytes(t.http.method.to_uppercase().as_bytes()).unwrap_or(reqwest::Method::GET);
    let start = Instant::now();
    let resp = client.request(method, &url).send().await;
    let fail = |e: String, code: Option<u16>| Sample { ts, rtt_ms: None, status_code: code, error: Some(e), hops: vec![] };
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let msg = if e.is_timeout() {
                "таймаут".to_string()
            } else if e.is_connect() {
                format!("ошибка соединения: {}", root_cause(&e))
            } else {
                root_cause(&e)
            };
            return fail(msg, None);
        }
    };
    // Время ответа — до получения заголовков (TTFB), как в сервисах аптайм-мониторинга.
    // Скачивание тела зависит от размера страницы и не говорит о доступности.
    let rtt = ms(start.elapsed());
    let code = resp.status().as_u16();
    let status_ok = if t.http.expected_status.is_empty() {
        resp.status().is_success() || resp.status().is_redirection()
    } else {
        t.http.expected_status.contains(&code)
    };
    let body_ok = if t.http.keyword.is_empty() {
        let _ = resp.bytes().await;
        true
    } else {
        match resp.text().await {
            Ok(body) => body.contains(&t.http.keyword),
            Err(e) => return fail(format!("ошибка чтения тела: {e}"), Some(code)),
        }
    };
    if !status_ok {
        return fail(format!("неожиданный код ответа {code}"), Some(code));
    }
    if !body_ok {
        return fail(format!("в ответе нет строки «{}»", t.http.keyword), Some(code));
    }
    Sample { ts, rtt_ms: Some(rtt), status_code: Some(code), error: None, hops: vec![] }
}

fn root_cause(e: &dyn std::error::Error) -> String {
    let mut cur: &dyn std::error::Error = e;
    while let Some(s) = cur.source() {
        cur = s;
    }
    cur.to_string()
}

pub async fn tcp_check(host: &str, port: u16, timeout: Duration) -> Sample {
    let ts = now_ms();
    let start = Instant::now();
    let res = tokio::time::timeout(timeout, async {
        let ip = resolve(host).await?;
        tokio::net::TcpStream::connect((ip, port)).await.map_err(anyhow::Error::from)
    })
    .await;
    match res {
        Ok(Ok(_s)) => Sample { ts, rtt_ms: Some(ms(start.elapsed())), status_code: None, error: None, hops: vec![] },
        Ok(Err(e)) => Sample { ts, rtt_ms: None, status_code: None, error: Some(e.to_string()), hops: vec![] },
        Err(_) => Sample { ts, rtt_ms: None, status_code: None, error: Some("таймаут".into()), hops: vec![] },
    }
}

/// DNS-проверка.
/// * адрес цели — IP: это DNS-сервер, спрашиваем у него `dns.query` напрямую (UDP/53);
/// * адрес цели — имя: резолвим его системным резолвером.
///
/// Если заданы ожидаемые IP, ответ без них считается ошибкой. Возвращает сэмпл и строку ответа.
pub async fn dns_check(t: &Target, timeout: Duration) -> (Sample, Option<String>) {
    let ts = now_ms();
    let start = Instant::now();
    let fail = |e: String, answer: Option<String>| (Sample { ts, rtt_ms: None, status_code: None, error: Some(e), hops: vec![] }, answer);
    let result: Result<Vec<IpAddr>, String> = match t.host.trim().parse::<IpAddr>() {
        Ok(server) => {
            let q = if t.dns.query.trim().is_empty() { "example.com".to_string() } else { t.dns.query.trim().to_string() };
            dns_query(server, &q, timeout).await
        }
        Err(_) => {
            let h = t.host.trim().to_string();
            match tokio::time::timeout(timeout, tokio::task::spawn_blocking(move || dns_lookup::lookup_host(&h))).await {
                Ok(Ok(Ok(a))) => Ok(a),
                Ok(Ok(Err(e))) => Err(format!("DNS: {e}")),
                _ => Err("таймаут DNS".into()),
            }
        }
    };
    let rtt = ms(start.elapsed());
    match result {
        Err(e) => fail(e, None),
        Ok(addrs) if addrs.is_empty() => fail("пустой ответ DNS".into(), None),
        Ok(addrs) => {
            let answer = addrs.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", ");
            let expected: Vec<IpAddr> = t.dns.expected.iter().filter_map(|x| x.trim().parse().ok()).collect();
            if !expected.is_empty() && !addrs.iter().any(|a| expected.contains(a)) {
                let exp = expected.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", ");
                return fail(format!("неожиданный ответ {answer} (ожидался {exp})"), Some(answer));
            }
            (Sample { ts, rtt_ms: Some(rtt), status_code: None, error: None, hops: vec![] }, Some(answer))
        }
    }
}

/// Запрос A-записи напрямую у DNS-сервера по UDP.
pub async fn dns_query(server: IpAddr, name: &str, timeout: Duration) -> Result<Vec<IpAddr>, String> {
    let id: u16 = (now_ms() as u16) ^ 0x5a5a;
    let packet = build_dns_query(id, name).map_err(|e| e.to_string())?;
    let bind: std::net::SocketAddr = if server.is_ipv4() { "0.0.0.0:0".parse().unwrap() } else { "[::]:0".parse().unwrap() };
    let fut = async {
        let sock = tokio::net::UdpSocket::bind(bind).await.map_err(|e| e.to_string())?;
        sock.connect((server, 53)).await.map_err(|e| e.to_string())?;
        sock.send(&packet).await.map_err(|e| e.to_string())?;
        let mut buf = [0u8; 1500];
        loop {
            let n = sock.recv(&mut buf).await.map_err(|e| e.to_string())?;
            if n >= 2 && u16::from_be_bytes([buf[0], buf[1]]) == id {
                return parse_dns_response(&buf[..n]);
            }
        }
    };
    tokio::time::timeout(timeout, fut).await.map_err(|_| "таймаут DNS".to_string())?
}

pub fn build_dns_query(id: u16, name: &str) -> Result<Vec<u8>> {
    let mut p = Vec::with_capacity(64);
    p.extend_from_slice(&id.to_be_bytes());
    p.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]); // RD, QDCOUNT=1
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(anyhow!("неверное имя для DNS-запроса: {name}"));
        }
        p.push(label.len() as u8);
        p.extend_from_slice(label.as_bytes());
    }
    p.extend_from_slice(&[0, 0, 1, 0, 1]); // конец имени, QTYPE=A, QCLASS=IN
    Ok(p)
}

fn skip_name(b: &[u8], mut i: usize) -> Option<usize> {
    loop {
        let len = *b.get(i)? as usize;
        if len == 0 {
            return Some(i + 1);
        }
        if len & 0xC0 == 0xC0 {
            return Some(i + 2);
        }
        i += len + 1;
    }
}

pub fn parse_dns_response(b: &[u8]) -> Result<Vec<IpAddr>, String> {
    if b.len() < 12 {
        return Err("короткий ответ DNS".into());
    }
    let rcode = b[3] & 0x0F;
    match rcode {
        0 => {}
        2 => return Err("DNS-сервер: ошибка сервера (SERVFAIL)".into()),
        3 => return Err("DNS-сервер: имя не найдено (NXDOMAIN)".into()),
        5 => return Err("DNS-сервер отказал в запросе (REFUSED)".into()),
        c => return Err(format!("DNS-сервер вернул ошибку {c}")),
    }
    let qd = u16::from_be_bytes([b[4], b[5]]) as usize;
    let an = u16::from_be_bytes([b[6], b[7]]) as usize;
    let mut i = 12;
    for _ in 0..qd {
        i = skip_name(b, i).ok_or("битый ответ DNS")? + 4;
    }
    let mut out = Vec::new();
    for _ in 0..an {
        i = skip_name(b, i).ok_or("битый ответ DNS")?;
        if i + 10 > b.len() {
            break;
        }
        let typ = u16::from_be_bytes([b[i], b[i + 1]]);
        let len = u16::from_be_bytes([b[i + 8], b[i + 9]]) as usize;
        let data = b.get(i + 10..i + 10 + len).ok_or("битый ответ DNS")?;
        match (typ, len) {
            (1, 4) => out.push(IpAddr::from([data[0], data[1], data[2], data[3]])),
            (28, 16) => {
                let mut a = [0u8; 16];
                a.copy_from_slice(data);
                out.push(IpAddr::from(a));
            }
            _ => {}
        }
        i += 10 + len;
    }
    Ok(out)
}

/// Сколько дней осталось до истечения TLS-сертификата.
pub async fn cert_days_left(url: &str, timeout: Duration) -> Result<i64> {
    let u = url::Url::parse(&normalize_url(url))?;
    if u.scheme() != "https" {
        return Err(anyhow!("не https"));
    }
    let host = u.host_str().ok_or_else(|| anyhow!("нет хоста"))?.to_string();
    let port = u.port_or_known_default().unwrap_or(443);
    tokio::time::timeout(timeout, async move {
        let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
        let cx = native_tls::TlsConnector::builder().danger_accept_invalid_certs(true).build()?;
        let cx = tokio_native_tls::TlsConnector::from(cx);
        let tls = cx.connect(&host, tcp).await?;
        let cert = tls
            .get_ref()
            .peer_certificate()?
            .ok_or_else(|| anyhow!("сервер не прислал сертификат"))?;
        let der = cert.to_der()?;
        let (_, parsed) = x509_parser::parse_x509_certificate(&der).map_err(|e| anyhow!("x509: {e}"))?;
        let not_after = parsed.validity().not_after.timestamp();
        Ok::<i64, anyhow::Error>((not_after - chrono::Utc::now().timestamp()) / 86_400)
    })
    .await
    .map_err(|_| anyhow!("таймаут TLS"))?
}
