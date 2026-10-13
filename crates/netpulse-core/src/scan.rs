//! Сканирование сети по кнопке: глубокая трассировка всех целей и поиск устройств в подсетях.
//!
//! Всё своими силами, без внешних программ: ICMP-трассировка (несколько проходов), пинг-обход
//! подсетей, MAC-адреса из ARP-таблицы системы, производитель по MAC (встроенная база IEEE OUI),
//! открытые типовые порты, баннеры сервисов (SSH, HTTP, FTP, SMTP, Telnet), имена из DNS.
//! Результат — снимок с датой: по нему строится карта и (дальше) инвентаризация.

use crate::checks::{self, now_ms};
use netpulse_icmp::{Pinger, ReplyKind};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Ход сканирования — для индикатора в интерфейсе.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub running: bool,
    /// Что делается сейчас (по-русски, для пользователя).
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub started: i64,
    pub finished: i64,
    pub error: Option<String>,
    /// Готовый снимок.
    pub scan_id: Option<String>,
}

/// Маршрут до цели по итогам нескольких проходов.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanTrace {
    pub target_id: String,
    pub ip: String,
    /// Хопы по порядку (без самой цели); null — хоп не ответил ни в одном проходе.
    pub hops: Vec<Option<String>>,
    pub reached: bool,
    /// Другие варианты пути, если проходы разошлись (балансировка).
    #[serde(default)]
    pub alt: Vec<Vec<Option<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub port: u16,
    pub name: String,
    /// Первая строка приветствия, заголовок сервера или страницы.
    pub banner: Option<String>,
}

/// Устройство, найденное в подсети (или цель, у которой удалось что-то узнать).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub ip: String,
    pub subnet: String,
    pub mac: Option<String>,
    pub vendor: Option<String>,
    pub name: Option<String>,
    pub rtt: Option<f32>,
    /// Отвечает ли на пинг (иначе найден только по ARP).
    pub ping: bool,
    pub ports: Vec<u16>,
    pub services: Vec<Service>,
    /// Тип устройства по косвенным признакам: router, switch, wifi, server, pc, printer, camera, ups, storage, phone, device.
    pub kind: Option<String>,
    /// Операционная система, если удалось понять, и откуда это известно.
    pub os: Option<String>,
    pub os_source: Option<String>,
    /// Цель мониторинга с этим адресом.
    pub target_id: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub id: String,
    pub started: i64,
    pub finished: i64,
    pub local_ip: Option<String>,
    /// Шлюз: первый хоп почти всех маршрутов.
    pub gateway: Option<String>,
    pub subnets: Vec<String>,
    pub traces: Vec<ScanTrace>,
    pub devices: Vec<Device>,
    /// Имена хопов из обратного DNS.
    pub names: BTreeMap<String, String>,
}

/// Краткая запись о снимке — для списка.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanInfo {
    pub id: String,
    pub started: i64,
    pub finished: i64,
    pub traces: usize,
    pub devices: usize,
}

pub struct ScanJob {
    pub targets: Vec<(String, IpAddr)>,
    pub subnets: Vec<String>,
    pub local_ip: Option<IpAddr>,
    /// Что уже знали об устройствах в прошлый раз (для «впервые замечено»).
    pub previous: HashMap<String, i64>,
}

const PASSES: usize = 3;
const TRACE_PARALLEL: usize = 6;
const SWEEP_PARALLEL: usize = 96;
const PORT_HOSTS_PARALLEL: usize = 24;
const MAX_HOSTS_PER_SUBNET: u32 = 1024;
/// Типовые порты: по ним видно, что за устройство.
pub const PORTS: &[(u16, &str)] = &[
    (21, "FTP"), (22, "SSH"), (23, "Telnet"), (25, "SMTP"), (53, "DNS"), (80, "HTTP"), (110, "POP3"),
    (135, "RPC"), (139, "NetBIOS"), (143, "IMAP"), (389, "LDAP"), (443, "HTTPS"), (445, "SMB"),
    (515, "LPD"), (554, "RTSP"), (631, "IPP"), (1433, "MS SQL"), (1723, "PPTP"), (3306, "MySQL"),
    (3389, "RDP"), (5000, "HTTP-alt"), (5432, "PostgreSQL"), (5900, "VNC"), (8000, "HTTP-alt"),
    (8006, "Proxmox"), (8080, "HTTP-alt"), (8291, "Winbox"), (8443, "HTTPS-alt"), (8728, "RouterOS API"),
    (9100, "Печать"), (9443, "HTTPS-alt"), (10000, "Webmin"),
];

/// Разбор «10.0.0.0/24», «10.0.0.5» (как /32) — список адресов для обхода.
pub fn subnet_hosts(cidr: &str) -> Result<Vec<Ipv4Addr>, String> {
    let s = cidr.trim();
    let (ip, bits) = match s.split_once('/') {
        Some((a, b)) => (a.trim(), b.trim().parse::<u32>().map_err(|_| format!("неверная маска в «{s}»"))?),
        None => (s, 32),
    };
    let ip: Ipv4Addr = ip.parse().map_err(|_| format!("неверный адрес в «{s}»"))?;
    if bits > 32 {
        return Err(format!("неверная маска в «{s}»"));
    }
    let size: u64 = 1u64 << (32 - bits);
    if size > MAX_HOSTS_PER_SUBNET as u64 * 4 {
        return Err(format!("подсеть «{s}» слишком большая — не больше /22"));
    }
    let base = u32::from(ip) & if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
    if bits >= 31 {
        return Ok((0..size as u32).map(|i| Ipv4Addr::from(base + i)).collect());
    }
    Ok((1..size as u32 - 1).map(|i| Ipv4Addr::from(base + i)).collect())
}

/// Подсеть /24 вокруг адреса.
pub fn net24(ip: IpAddr) -> Option<String> {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            Some(format!("{}.{}.{}.0/24", o[0], o[1], o[2]))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------- производитель по MAC

static OUI: OnceLock<HashMap<u32, String>> = OnceLock::new();

fn oui_db() -> &'static HashMap<u32, String> {
    OUI.get_or_init(|| {
        use std::io::Read;
        let gz: &[u8] = include_bytes!("../data/oui.txt.gz");
        let mut s = String::new();
        let _ = flate2::read::GzDecoder::new(gz).read_to_string(&mut s);
        s.lines()
            .filter_map(|l| {
                let (k, v) = l.split_once('\t')?;
                Some((u32::from_str_radix(k, 16).ok()?, v.to_string()))
            })
            .collect()
    })
}

/// Производитель по MAC-адресу (база IEEE). Для «случайных» MAC (телефоны) — пометка.
pub fn vendor_of(mac: &str) -> Option<String> {
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() < 6 {
        return None;
    }
    let pre = u32::from_str_radix(&hex[..6], 16).ok()?;
    if let Some(v) = oui_db().get(&pre) {
        return Some(v.clone());
    }
    // Бит «локально назначенный»: случайный адрес (приватный MAC телефона/ноутбука).
    if (pre >> 16) & 0x02 != 0 {
        return Some("случайный MAC (телефон или ноутбук)".into());
    }
    None
}

/// Приводит MAC к виду AA:BB:CC:DD:EE:FF (macOS пишет без ведущих нулей, Windows — через дефис).
pub fn normalize_mac(raw: &str) -> Option<String> {
    let parts: Vec<&str> = raw.split(|c| c == ':' || c == '-').collect();
    if parts.len() != 6 {
        return None;
    }
    let mut out = Vec::with_capacity(6);
    for p in parts {
        let v = u8::from_str_radix(p, 16).ok()?;
        out.push(format!("{v:02X}"));
    }
    let s = out.join(":");
    if s == "00:00:00:00:00:00" || s == "FF:FF:FF:FF:FF:FF" {
        return None;
    }
    Some(s)
}

/// ARP-таблица системы: IP → MAC. Пинг-обход заполняет её даже для тех, кто не отвечает на пинг.
pub fn arp_table() -> HashMap<Ipv4Addr, String> {
    let mut cmd = std::process::Command::new("arp");
    cmd.arg(if cfg!(windows) { "-a" } else { "-an" });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // без окна консоли
    }
    let Ok(out) = cmd.output() else { return HashMap::new() };
    parse_arp(&String::from_utf8_lossy(&out.stdout))
}

pub fn parse_arp(text: &str) -> HashMap<Ipv4Addr, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        // macOS/Linux: «? (10.0.0.1) at 0:1a:2b:3c:4d:5e on en0 ...»; Windows: «  10.0.0.1   00-1a-2b-3c-4d-5e   dynamic».
        let mut ip = None;
        let mut mac = None;
        for tok in line.split_whitespace() {
            let t = tok.trim_matches(|c| c == '(' || c == ')');
            if ip.is_none() {
                if let Ok(v) = t.parse::<Ipv4Addr>() {
                    ip = Some(v);
                    continue;
                }
            }
            if mac.is_none() {
                mac = normalize_mac(t);
            }
        }
        if let (Some(i), Some(m)) = (ip, mac) {
            if !i.is_multicast() && !i.is_broadcast() {
                map.insert(i, m);
            }
        }
    }
    map
}

// ---------------------------------------------------------------- порты и баннеры

async fn port_open(ip: IpAddr, port: u16, timeout: Duration) -> Option<tokio::net::TcpStream> {
    tokio::time::timeout(timeout, tokio::net::TcpStream::connect(SocketAddr::new(ip, port))).await.ok()?.ok()
}

fn clean(s: &str, max: usize) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    t.chars().take(max).collect()
}

async fn read_line(stream: &mut tokio::net::TcpStream, timeout: Duration) -> Option<String> {
    let mut buf = vec![0u8; 512];
    let n = tokio::time::timeout(timeout, stream.read(&mut buf)).await.ok()?.ok()?;
    if n == 0 {
        return None;
    }
    let s = String::from_utf8_lossy(&buf[..n]);
    let first = s.lines().next().unwrap_or("").to_string();
    let c = clean(&first, 120);
    (!c.is_empty()).then_some(c)
}

fn html_title(body: &str) -> Option<String> {
    let low = body.to_lowercase();
    let a = low.find("<title")?;
    let a = a + low[a..].find('>')? + 1;
    let b = a + low[a..].find("</title")?;
    let t = clean(&body[a..b], 80);
    (!t.is_empty()).then_some(t)
}

/// Что за сервис на порту: приветствие, заголовок сервера, заголовок страницы.
async fn banner(ip: IpAddr, port: u16, stream: tokio::net::TcpStream) -> Option<String> {
    let t = Duration::from_millis(1500);
    match port {
        22 | 21 | 23 | 25 | 110 | 143 => {
            let mut s = stream;
            read_line(&mut s, t).await
        }
        80 | 5000 | 8000 | 8080 | 10000 => {
            let mut s = stream;
            let req = format!("GET / HTTP/1.0\r\nHost: {ip}\r\nUser-Agent: NetPulse\r\n\r\n");
            tokio::time::timeout(t, s.write_all(req.as_bytes())).await.ok()?.ok()?;
            let mut buf = Vec::new();
            let _ = tokio::time::timeout(t, async {
                let mut chunk = [0u8; 4096];
                while buf.len() < 32 * 1024 {
                    match s.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
            })
            .await;
            http_summary(&String::from_utf8_lossy(&buf))
        }
        443 | 8443 | 9443 | 8006 => {
            drop(stream);
            let client = reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true)
                .redirect(reqwest::redirect::Policy::limited(3))
                .timeout(Duration::from_secs(3))
                .build()
                .ok()?;
            let r = client.get(format!("https://{ip}:{port}/")).send().await.ok()?;
            let server = r.headers().get("server").and_then(|v| v.to_str().ok()).map(|v| clean(v, 60));
            let body = r.text().await.unwrap_or_default();
            join_summary(server, html_title(&body))
        }
        _ => None,
    }
}

fn http_summary(resp: &str) -> Option<String> {
    let (head, body) = resp.split_once("\r\n\r\n").unwrap_or((resp, ""));
    let server = head
        .lines()
        .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("server")).map(|(_, v)| clean(v, 60)));
    join_summary(server, html_title(body))
}

fn join_summary(server: Option<String>, title: Option<String>) -> Option<String> {
    match (server, title) {
        (Some(s), Some(t)) => Some(format!("{s} · «{t}»")),
        (Some(s), None) => Some(s),
        (None, Some(t)) => Some(format!("«{t}»")),
        _ => None,
    }
}

// ---------------------------------------------------------------- что за устройство

/// Тип устройства и ОС по производителю, портам и баннерам. Грубо, но без прав и без агентов.
pub fn classify(d: &mut Device) {
    let v = d.vendor.clone().unwrap_or_default().to_lowercase();
    let name = d.name.clone().unwrap_or_default().to_lowercase();
    let has = |p: u16| d.ports.contains(&p);
    let banners: String = d.services.iter().filter_map(|s| s.banner.clone()).collect::<Vec<_>>().join(" | ");
    let b = banners.to_lowercase();
    let vend = |list: &[&str]| list.iter().any(|x| v.contains(x));

    // ОС и её источник — по баннерам сервисов.
    let mut os: Option<(String, &str)> = None;
    if let Some(ssh) = d.services.iter().find(|s| s.port == 22).and_then(|s| s.banner.clone()) {
        let l = ssh.to_lowercase();
        let ver = ssh.split_whitespace().next().unwrap_or("").to_string();
        let guess = if l.contains("rosssh") {
            Some("MikroTik RouterOS".to_string())
        } else if l.contains("ubuntu") {
            Some(format!("Ubuntu Linux ({ver})"))
        } else if l.contains("debian") {
            Some(format!("Debian Linux ({ver})"))
        } else if l.contains("raspbian") {
            Some(format!("Raspberry Pi OS ({ver})"))
        } else if l.contains("freebsd") {
            Some(format!("FreeBSD ({ver})"))
        } else if l.contains("cisco") {
            Some("Cisco IOS".to_string())
        } else if l.contains("dropbear") {
            Some(format!("встраиваемый Linux ({ver})"))
        } else if l.contains("openssh_for_windows") {
            Some("Windows (OpenSSH)".to_string())
        } else if l.contains("openssh") {
            Some(format!("Linux/Unix ({ver})"))
        } else {
            None
        };
        if let Some(g) = guess {
            os = Some((g, "SSH"));
        }
    }
    if os.is_none() {
        if b.contains("microsoft-iis") || b.contains("microsoft-httpapi") {
            os = Some(("Windows Server".into(), "HTTP"));
        } else if has(3389) || (has(445) && has(135)) {
            os = Some(("Windows".into(), "порты RDP/SMB"));
        } else if b.contains("mikrotik") || has(8291) {
            os = Some(("MikroTik RouterOS".into(), if has(8291) { "порт Winbox" } else { "HTTP" }));
        } else if has(8006) || b.contains("proxmox") {
            os = Some(("Proxmox VE".into(), "HTTP"));
        } else if b.contains("synology") || b.contains("diskstation") {
            os = Some(("Synology DSM".into(), "HTTP"));
        } else if v.contains("apple") && !has(445) {
            os = Some(("Apple (macOS/iOS)".into(), "MAC"));
        }
    }
    if let Some((o, src)) = os {
        d.os = Some(o);
        d.os_source = Some(src.into());
    }

    let os_l = d.os.clone().unwrap_or_default().to_lowercase();
    let kind = if has(9100) || has(515) || has(631) || vend(&["hewlett", "hp inc", "canon", "kyocera", "epson", "brother", "xerox", "ricoh", "lexmark", "konica", "sharp", "oki"]) && (has(80) || has(443) || has(9100)) {
        "printer"
    } else if has(554) || vend(&["hikvision", "dahua", "axis", "hanwha", "uniview", "trassir", "beward", "polyvision"]) {
        "camera"
    } else if os_l.contains("routeros") || has(8291) || has(8728) || vend(&["mikrotik", "routerboard", "juniper", "keenetic", "zyxel"]) {
        "router"
    } else if vend(&["ubiquiti", "aruba", "ruckus", "cambium", "grandstream", "mimosa", "engenius"]) || b.contains("unifi") {
        "wifi"
    } else if vend(&["cisco", "huawei", "d-link", "tp-link", "netgear", "edgecore", "eltex", "snr", "hpe", "extreme", "allied"]) && !has(445) && !has(3389) {
        "switch"
    } else if vend(&["apc", "american power", "eaton", "schneider", "ippon", "powercom", "delta electronics"]) {
        "ups"
    } else if vend(&["synology", "qnap", "netapp", "buffalo", "western digital", "seagate"]) || os_l.contains("synology") {
        "storage"
    } else if os_l.contains("proxmox") || vend(&["vmware"]) || b.contains("esxi") {
        "hypervisor"
    } else if vend(&["yealink", "polycom", "fanvil", "snom", "avaya", "grandstream"]) || has(5060) {
        "phone"
    } else if os_l.contains("windows server") || ((has(3389) || has(445)) && (name.contains("srv") || name.contains("dc") || name.contains("sql") || has(1433) || has(389))) {
        "server"
    } else if has(3389) || has(445) || os_l.contains("apple") {
        "pc"
    } else if has(22) && (os_l.contains("linux") || os_l.contains("bsd")) {
        "server"
    } else {
        "device"
    };
    d.kind = Some(kind.into());
}

// ---------------------------------------------------------------- сам скан

fn set(progress: &Mutex<ScanProgress>, phase: &str, done: usize, total: usize) {
    let mut p = progress.lock();
    p.phase = phase.to_string();
    p.done = done;
    p.total = total;
}

pub async fn run(pinger: Pinger, job: ScanJob, progress: Arc<Mutex<ScanProgress>>, cancel: Arc<AtomicBool>) -> Result<ScanResult, String> {
    let started = now_ms();
    let stop = || cancel.load(Ordering::Relaxed);

    // 1. Глубокая трассировка целей: несколько проходов, итог — самый частый адрес на каждом шаге.
    let total = job.targets.len();
    set(&progress, "Трассировка целей", 0, total);
    let mut traces = Vec::new();
    let can_trace = pinger.supports_trace();
    let mut done = 0;
    for chunk in job.targets.chunks(TRACE_PARALLEL) {
        if stop() {
            return Err("остановлено".into());
        }
        let res = futures::future::join_all(chunk.iter().map(|(id, ip)| {
            let p = pinger.clone();
            let (id, ip) = (id.clone(), *ip);
            async move {
                let mut passes = Vec::new();
                if can_trace {
                    for _ in 0..PASSES {
                        passes.push(checks::trace_round(&p, ip, 30, 64, Duration::from_millis(1500)).await);
                    }
                }
                (id, ip, passes)
            }
        }))
        .await;
        for (id, ip, passes) in res {
            traces.push(merge_passes(id, ip, &passes));
        }
        done += chunk.len();
        set(&progress, "Трассировка целей", done, total);
    }

    // Имена хопов.
    let hop_ips: HashSet<IpAddr> = traces.iter().flat_map(|t| t.hops.iter().flatten().filter_map(|h| h.parse().ok())).collect();
    set(&progress, "Имена узлов на маршрутах", 0, hop_ips.len());
    let mut names = BTreeMap::new();
    let list: Vec<IpAddr> = hop_ips.into_iter().collect();
    for chunk in list.chunks(32) {
        if stop() {
            return Err("остановлено".into());
        }
        let r = futures::future::join_all(chunk.iter().map(|ip| async move { (*ip, checks::reverse_dns(*ip).await) })).await;
        for (ip, n) in r {
            if let Some(n) = n {
                names.insert(ip.to_string(), n);
            }
        }
    }
    let gateway = {
        let mut cnt: HashMap<&str, usize> = HashMap::new();
        for t in &traces {
            if let Some(Some(h)) = t.hops.first() {
                *cnt.entry(h.as_str()).or_default() += 1;
            }
        }
        cnt.into_iter().max_by_key(|x| x.1).map(|x| x.0.to_string())
    };

    // 2. Пинг-обход подсетей.
    let mut hosts: Vec<(Ipv4Addr, String)> = Vec::new();
    for s in &job.subnets {
        for ip in subnet_hosts(s)? {
            hosts.push((ip, s.clone()));
        }
    }
    let local_v4 = match job.local_ip {
        Some(IpAddr::V4(v)) => Some(v),
        _ => None,
    };
    hosts.retain(|(ip, _)| Some(*ip) != local_v4);
    set(&progress, "Поиск устройств в подсетях", 0, hosts.len());
    let mut alive: HashMap<Ipv4Addr, Option<f32>> = HashMap::new();
    let mut swept = 0;
    for chunk in hosts.chunks(SWEEP_PARALLEL) {
        if stop() {
            return Err("остановлено".into());
        }
        let r = futures::future::join_all(chunk.iter().map(|(ip, _)| {
            let p = pinger.clone();
            let ip = *ip;
            async move {
                let rep = p.probe(IpAddr::V4(ip), 64, 32, Duration::from_millis(900)).await.ok().flatten();
                (ip, rep.filter(|r| r.kind == ReplyKind::Echo).map(|r| r.rtt.as_secs_f32() * 1000.0))
            }
        }))
        .await;
        for (ip, rtt) in r {
            if let Some(v) = rtt {
                alive.insert(ip, Some(v));
            }
        }
        swept += chunk.len();
        set(&progress, "Поиск устройств в подсетях", swept, hosts.len());
    }
    // MAC-адреса: после обхода ARP-таблица знает и тех, кто на пинг не отвечает (только своя подсеть).
    let arp = arp_table();
    let subnet_of: HashMap<Ipv4Addr, String> = hosts.iter().cloned().collect();
    for ip in arp.keys() {
        if subnet_of.contains_key(ip) {
            alive.entry(*ip).or_insert(None);
        }
    }

    // 3. Порты, баннеры, имена.
    let mut ips: Vec<Ipv4Addr> = alive.keys().copied().collect();
    ips.sort();
    set(&progress, "Опознаю устройства", 0, ips.len());
    let mut devices = Vec::new();
    let mut probed = 0;
    for chunk in ips.chunks(PORT_HOSTS_PARALLEL) {
        if stop() {
            return Err("остановлено".into());
        }
        let r = futures::future::join_all(chunk.iter().map(|ip| async move {
            let addr = IpAddr::V4(*ip);
            let opens = futures::future::join_all(PORTS.iter().map(|(port, name)| async move {
                let s = port_open(addr, *port, Duration::from_millis(700)).await?;
                let b = banner(addr, *port, s).await;
                Some(Service { port: *port, name: name.to_string(), banner: b })
            }))
            .await;
            let services: Vec<Service> = opens.into_iter().flatten().collect();
            let name = checks::reverse_dns(addr).await;
            (*ip, services, name)
        }))
        .await;
        for (ip, services, name) in r {
            let mac = arp.get(&ip).cloned();
            let key = mac.clone().unwrap_or_else(|| ip.to_string());
            let mut d = Device {
                ip: ip.to_string(),
                subnet: subnet_of.get(&ip).cloned().unwrap_or_default(),
                vendor: mac.as_deref().and_then(vendor_of),
                mac,
                name,
                rtt: alive.get(&ip).copied().flatten(),
                ping: alive.get(&ip).map_or(false, |r| r.is_some()),
                ports: services.iter().map(|s| s.port).collect(),
                services,
                kind: None,
                os: None,
                os_source: None,
                target_id: job.targets.iter().find(|(_, t)| *t == IpAddr::V4(ip)).map(|(id, _)| id.clone()),
                first_seen: job.previous.get(&key).copied().unwrap_or(started),
                last_seen: started,
            };
            classify(&mut d);
            devices.push(d);
        }
        probed += chunk.len();
        set(&progress, "Опознаю устройства", probed, ips.len());
    }
    Ok(ScanResult {
        id: format!("{started}"),
        started,
        finished: now_ms(),
        local_ip: job.local_ip.map(|a| a.to_string()),
        gateway,
        subnets: job.subnets,
        traces,
        devices,
        names,
    })
}

/// Сводит проходы трассировки: на каждом шаге — самый частый ответивший адрес.
fn merge_passes(id: String, ip: IpAddr, passes: &[checks::TraceRound]) -> ScanTrace {
    let len = passes.iter().map(|p| p.hops.len()).max().unwrap_or(0);
    let reached = passes.iter().any(|p| p.reached_ttl.is_some());
    let reach_len = passes.iter().filter_map(|p| p.reached_ttl).min().map(|t| t as usize);
    let mut hops = Vec::new();
    for i in 0..len {
        let mut cnt: HashMap<IpAddr, usize> = HashMap::new();
        for p in passes {
            if let Some(Some(a)) = p.hops.get(i).map(|h| h.addr) {
                *cnt.entry(a).or_default() += 1;
            }
        }
        hops.push(cnt.into_iter().max_by_key(|x| x.1).map(|x| x.0));
    }
    // Хвост: цель — не хоп; сплошные таймауты в конце — не хопы.
    if let Some(n) = reach_len {
        hops.truncate(n);
    }
    if hops.last().copied().flatten() == Some(ip) {
        hops.pop();
    }
    while hops.last().map_or(false, |h| h.is_none()) {
        hops.pop();
    }
    let main: Vec<Option<String>> = hops.iter().map(|h| h.map(|a| a.to_string())).collect();
    let mut alt: Vec<Vec<Option<String>>> = Vec::new();
    for p in passes {
        let mut v: Vec<Option<String>> = p.hops.iter().map(|h| h.addr.map(|a| a.to_string())).collect();
        if v.last().cloned().flatten() == Some(ip.to_string()) {
            v.pop();
        }
        while v.last().map_or(false, |h| h.is_none()) {
            v.pop();
        }
        let differs = v.iter().zip(&main).any(|(a, b)| a.is_some() && b.is_some() && a != b);
        if differs && !alt.contains(&v) {
            alt.push(v);
        }
    }
    ScanTrace { target_id: id, ip: ip.to_string(), hops: main, reached, alt }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subnets() {
        assert_eq!(subnet_hosts("10.0.0.0/24").unwrap().len(), 254);
        assert_eq!(subnet_hosts("10.0.0.7/30").unwrap(), vec![Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(10, 0, 0, 6)]);
        assert_eq!(subnet_hosts("10.0.0.9").unwrap(), vec![Ipv4Addr::new(10, 0, 0, 9)]);
        assert!(subnet_hosts("10.0.0.0/16").is_err());
        assert_eq!(net24("192.168.5.77".parse().unwrap()).unwrap(), "192.168.5.0/24");
    }

    #[test]
    fn arp_parse() {
        let mac = "? (192.168.1.1) at 0:1a:2b:c:4d:5e on en0 ifscope [ethernet]\n? (192.168.1.9) at (incomplete) on en0 ifscope [ethernet]\n";
        let m = parse_arp(mac);
        assert_eq!(m.get(&Ipv4Addr::new(192, 168, 1, 1)).unwrap(), "00:1A:2B:0C:4D:5E");
        assert_eq!(m.len(), 1);
        let win = "Interface: 192.168.1.50 --- 0x5\n  Internet Address      Physical Address      Type\n  192.168.1.1           00-1a-2b-3c-4d-5e     dynamic\n  192.168.1.255         ff-ff-ff-ff-ff-ff     static\n";
        let w = parse_arp(win);
        assert_eq!(w.get(&Ipv4Addr::new(192, 168, 1, 1)).unwrap(), "00:1A:2B:3C:4D:5E");
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn oui_lookup() {
        assert!(oui_db().len() > 30_000);
        assert_eq!(vendor_of("02:00:00:00:00:01").as_deref(), Some("случайный MAC (телефон или ноутбук)"));
    }

    #[test]
    fn classify_basics() {
        let mk = |ports: &[u16], vendor: Option<&str>, ssh: Option<&str>| {
            let mut d = Device {
                ip: "10.0.0.2".into(), subnet: String::new(), mac: None, vendor: vendor.map(Into::into), name: None, rtt: None, ping: true,
                ports: ports.to_vec(),
                services: ports.iter().map(|p| Service { port: *p, name: String::new(), banner: if *p == 22 { ssh.map(Into::into) } else { None } }).collect(),
                kind: None, os: None, os_source: None, target_id: None, first_seen: 0, last_seen: 0,
            };
            classify(&mut d);
            d
        };
        assert_eq!(mk(&[9100, 80], None, None).kind.as_deref(), Some("printer"));
        let r = mk(&[22, 8291], None, Some("SSH-2.0-ROSSSH"));
        assert_eq!(r.kind.as_deref(), Some("router"));
        assert_eq!(r.os.as_deref(), Some("MikroTik RouterOS"));
        let w = mk(&[135, 445, 3389], None, None);
        assert_eq!(w.kind.as_deref(), Some("pc"));
        assert_eq!(w.os.as_deref(), Some("Windows"));
        let u = mk(&[22], None, Some("SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10"));
        assert_eq!(u.os.as_deref(), Some("Ubuntu Linux (SSH-2.0-OpenSSH_8.9p1)"));
        assert_eq!(u.kind.as_deref(), Some("server"));
    }
}
