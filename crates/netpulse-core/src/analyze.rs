//! Анализатор проблем: по результатам проверок цели и контексту (родитель, соседние цели,
//! история) объясняет, что происходит и на каком участке причина.
//!
//! Принципы:
//! * выводы делаются только на достаточном числе проверок и с учётом разрывов в данных;
//! * потери на промежуточном хопе считаются реальными только если они совпадают по времени
//!   с потерями до цели (иначе это ограничение ICMP на маршрутизаторе);
//! * задержка сравнивается по медиане, чтобы одиночные всплески не меняли вывод;
//! * каждый вывод называет зону ответственности и следующий шаг.

use crate::model::{CheckKind, Sample, Thresholds};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Info,
    Warn,
    Crit,
}

/// Где находится причина.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Zone {
    /// Компьютер мониторинга и его сеть.
    Monitor,
    /// Локальная сеть до вашего шлюза.
    Local,
    /// Внутренняя сеть: туннели, площадки, частные адреса.
    Internal,
    /// Ваш провайдер.
    Isp,
    /// Транзитный оператор.
    Transit,
    /// Сеть на стороне цели.
    Dest,
    /// Сам узел или сервис на нём.
    Target,
    /// Вышестоящий узел по зависимости.
    Parent,
    /// Общее наблюдение без привязки к участку.
    General,
}

impl Zone {
    /// Чем меньше, тем выше вывод в списке при равном уровне.
    fn prio(self) -> u8 {
        match self {
            Zone::Monitor => 0,
            Zone::Parent => 1,
            Zone::Local => 2,
            Zone::Internal => 3,
            Zone::Isp => 4,
            Zone::Transit => 5,
            Zone::Dest => 6,
            Zone::Target => 7,
            Zone::General => 8,
        }
    }
}

/// Тип правила — задаёт порядок выводов одного уровня.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Rule {
    Availability = 0,
    Loss = 1,
    Latency = 2,
    Jitter = 3,
    Cert = 4,
    Flaps = 5,
    Route = 6,
    Coverage = 7,
    Note = 8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub level: Level,
    pub zone: Zone,
    /// Коротко — для списка целей и уведомлений.
    pub short: String,
    pub title: String,
    pub detail: String,
    pub hint: Option<String>,
    /// Хоп, к которому относится вывод.
    pub ttl: Option<u8>,
    #[serde(skip)]
    rule: Rule,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub level: Level,
    pub summary: String,
    pub cause: Option<String>,
    pub findings: Vec<Finding>,
    pub from: i64,
    pub to: i64,
    pub samples: usize,
    /// Доля периода, покрытая проверками (0..1).
    pub coverage: f32,
    /// Анализ ограничен последними часами периода.
    pub clamped: bool,
    /// Данные устарели: последняя проверка давно.
    pub stale: bool,
}

/// Другая цель с трассировкой — для поиска общего участка маршрута.
pub struct OtherRoute {
    pub name: String,
    /// Цель сейчас считается недоступной (устойчиво, а не один потерянный пакет).
    pub failing: bool,
    pub route: Vec<IpAddr>,
}

/// Другая проверка того же адреса (ping рядом с trace, TCP-порт рядом с ping и т.д.).
pub struct SameHost {
    pub name: String,
    pub kind: CheckKind,
    /// Отвечает сейчас.
    pub ok: bool,
}

pub struct Input<'a> {
    pub kind: CheckKind,
    pub host: &'a str,
    pub th: &'a Thresholds,
    pub timeout_ms: u64,
    pub interval_ms: u64,
    /// Сколько подряд неудачных проверок считается недоступностью (из настроек).
    pub down_after: usize,
    /// Проверки окна анализа по возрастанию времени.
    pub samples: &'a [Sample],
    pub hostnames: &'a HashMap<IpAddr, String>,
    /// Последний известный рабочий маршрут (ttl → адрес) — чтобы назвать молчащий хоп.
    pub known_route: &'a [(u8, Option<IpAddr>)],
    /// Недоступный предок (имя) — только когда он устойчиво недоступен.
    pub parent_failing: Option<String>,
    /// (не отвечает, всего, различных первых внешних хопов у не отвечающих).
    pub monitor_wide: Option<(usize, usize, usize)>,
    /// Завершённые обрывы за последний час.
    pub flaps_hour: usize,
    /// Смена маршрута: время и описание.
    pub route_change: Option<(i64, String)>,
    /// Смена IP цели при резолве: время и описание.
    pub ip_change: Option<(i64, String)>,
    /// Часы, в которые проблемы повторяются в разные дни.
    pub peak_hours: Vec<u8>,
    pub others: Vec<OtherRoute>,
    pub same_host: Vec<SameHost>,
    pub cert_days: Option<i64>,
    pub cert_warn_days: i64,
    /// Ошибка резолва, если она относится к последним проверкам.
    pub resolve_error: Option<String>,
    /// Текущее время (для проверки свежести данных).
    pub now: i64,
    /// Период анализа обрезан.
    pub clamped: bool,
}

// ---------------------------------------------------------------- адреса и зоны

fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local(),
        IpAddr::V6(v) => {
            let s = v.segments()[0];
            v.is_loopback() || (s & 0xfe00) == 0xfc00 || (s & 0xffc0) == 0xfe80
        }
    }
}

/// Адреса операторского NAT (CGNAT): не ваша сеть, хотя и не публичные.
fn is_cgnat(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            o[0] == 100 && (64..128).contains(&o[1])
        }
        IpAddr::V6(_) => false,
    }
}

/// Организация по обратному имени: «ae3-227.rt.core.transit-b.example» → «transit-b.example».
pub fn org_of(host: &str) -> Option<String> {
    let h = host.trim_end_matches('.').to_lowercase();
    if h.parse::<IpAddr>().is_ok() {
        return None;
    }
    let labels: Vec<&str> = h.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() < 2 {
        return None;
    }
    let last = labels[labels.len() - 1];
    let two = format!("{}.{}", labels[labels.len() - 2], last);
    // Домены второго уровня, за которыми регистрируют имена (по ним нельзя различать операторов).
    const SECOND: [&str; 10] = ["com", "net", "org", "co", "gov", "edu", "ac", "mil", "biz", "pp"];
    let second_level = labels.len() >= 3 && last.len() == 2 && SECOND.contains(&labels[labels.len() - 2]);
    if second_level {
        return Some(format!("{}.{}", labels[labels.len() - 3], two));
    }
    Some(two)
}

struct HopZone {
    ttl: u8,
    zone: Zone,
    org: Option<String>,
}

/// Раскладывает маршрут по зонам: локальная сеть → провайдер → транзит → сеть получателя.
fn classify(route: &[(u8, Option<IpAddr>)], dest_ttl: Option<u8>, names: &HashMap<IpAddr, String>, target_private: bool) -> Vec<HopZone> {
    let org = |a: &Option<IpAddr>| a.and_then(|ip| names.get(&ip)).and_then(|n| org_of(n));
    let mut out: Vec<HopZone> = route.iter().map(|(ttl, a)| HopZone { ttl: *ttl, zone: Zone::General, org: org(a) }).collect();
    let first_public = route.iter().position(|(_, a)| a.map_or(false, |a| !is_private(&a) && !is_cgnat(&a)));
    for (i, h) in out.iter_mut().enumerate() {
        if Some(h.ttl) == dest_ttl {
            h.zone = Zone::Target;
            continue;
        }
        let before_public = first_public.map_or(true, |p| i < p);
        if before_public {
            // Первый хоп — всегда ваш шлюз. Дальше: внутренняя сеть, если цель тоже внутренняя,
            // а адреса операторского NAT — уже сеть провайдера.
            let cgnat = route[i].1.map_or(false, |a| is_cgnat(&a));
            h.zone = if i == 0 {
                Zone::Local
            } else if cgnat {
                Zone::Isp
            } else if target_private {
                Zone::Internal
            } else {
                Zone::Local
            };
        }
    }
    let Some(fp) = first_public else { return out };
    // Блоки операторов по домену; хопы без имени примыкают к предыдущему блоку.
    let idx: Vec<usize> = (fp..out.len()).filter(|&i| out[i].zone != Zone::Target).collect();
    let mut blocks: Vec<Vec<usize>> = vec![];
    for i in idx {
        let key = out[i].org.clone();
        match blocks.last_mut() {
            Some(b) if out[*b.last().unwrap()].org == key => b.push(i),
            Some(b) if key.is_none() => b.push(i),
            _ => blocks.push(vec![i]),
        }
    }
    let n = blocks.len();
    for (bi, b) in blocks.iter().enumerate() {
        // Сеть получателя — только последний блок, если операторов было несколько.
        let zone = if bi == 0 {
            Zone::Isp
        } else if bi == n - 1 && n >= 3 {
            Zone::Dest
        } else if bi == n - 1 && n == 2 {
            // Два оператора: последний — либо транзит, либо сеть цели. Решаем по близости к цели.
            let near_dest = dest_ttl.map_or(false, |d| b.iter().any(|&i| out[i].ttl + 1 >= d));
            if near_dest { Zone::Dest } else { Zone::Transit }
        } else {
            Zone::Transit
        };
        for &i in b {
            out[i].zone = zone;
        }
    }
    out
}

fn zone_name(z: Zone, org: &Option<String>) -> String {
    let o = org.as_ref().map(|o| format!(" ({o})")).unwrap_or_default();
    match z {
        Zone::Monitor => "компьютер мониторинга".into(),
        Zone::Local => "ваша локальная сеть".into(),
        Zone::Internal => "внутренняя сеть или туннель".into(),
        Zone::Isp => format!("ваш провайдер{o}"),
        Zone::Transit => format!("транзитный оператор{o}"),
        Zone::Dest => format!("сеть на стороне цели{o}"),
        Zone::Target => "сам узел".into(),
        Zone::Parent => "вышестоящий узел".into(),
        Zone::General => "участок не определён".into(),
    }
}

fn zone_hint(z: Zone) -> &'static str {
    match z {
        Zone::Local => "Проверьте кабель или Wi-Fi этого компьютера, локальный маршрутизатор и VPN-подключение.",
        Zone::Internal => "Проверьте маршрутизатор, туннель (GRE, IPsec) или L2-канал на этом участке.",
        Zone::Isp => "Участок вашего провайдера: откройте заявку и приложите выгрузку проверок (кнопка CSV) с указанием времени.",
        Zone::Transit => "Участок транзитного оператора. Обычно решает он сам, ваш провайдер может увести трафик другим маршрутом — сообщите ему.",
        Zone::Dest => "Участок на стороне цели: сообщите тем, кто обслуживает этот узел или его канал.",
        Zone::Target => "Проверьте сам узел: питание, загрузку, состояние интерфейса, правила файрвола.",
        Zone::Monitor => "Проверьте сеть самого компьютера: кабель или Wi-Fi, VPN, DNS.",
        Zone::Parent => "Сначала восстановите вышестоящий узел.",
        Zone::General => "",
    }
}

fn clock(ts: i64) -> String {
    use chrono::{Local, TimeZone};
    Local.timestamp_millis_opt(ts).single().map(|d| d.format("%H:%M").to_string()).unwrap_or_default()
}

/// «1 обрыв», «3 обрыва», «7 обрывов».
pub fn plural(n: usize, one: &str, few: &str, many: &str) -> String {
    let (n10, n100) = (n % 10, n % 100);
    let w = if n10 == 1 && n100 != 11 {
        one
    } else if (2..=4).contains(&n10) && !(12..=14).contains(&n100) {
        few
    } else {
        many
    };
    format!("{n} {w}")
}

fn pct(v: f32) -> String {
    if v >= 10.0 {
        format!("{v:.0}%")
    } else {
        format!("{v:.1}%")
    }
}

fn pre(prefix: &str, text: String) -> String {
    if prefix.is_empty() {
        return text;
    }
    let mut c = text.chars();
    match c.next() {
        Some(f) => format!("{prefix}{}{}", f.to_lowercase(), c.as_str()),
        None => prefix.to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn f(level: Level, zone: Zone, rule: Rule, short: impl Into<String>, title: impl Into<String>, detail: impl Into<String>, hint: Option<String>, ttl: Option<u8>) -> Finding {
    Finding { level, zone, rule, short: short.into(), title: title.into(), detail: detail.into(), hint, ttl }
}

// ---------------------------------------------------------------- агрегаты

/// Статистика хопа по окну анализа: медиана, разброс, совпадение потерь с потерями до цели.
#[derive(Default, Clone)]
struct Agg {
    ttl: u8,
    addrs: HashSet<IpAddr>,
    last_addr: Option<IpAddr>,
    sent: u32,
    lost: u32,
    rtts: Vec<f32>,
    jitter_sum: f64,
    jitter_n: u32,
    /// Раундов, где хоп не ответил и цель тоже не ответила.
    lost_with_dest: u32,
    /// Раундов, где хоп ответил, а цель — нет.
    ok_dest_lost: u32,
    ok_rounds: u32,
}

impl Agg {
    fn loss_pct(&self) -> f32 {
        if self.sent == 0 {
            0.0
        } else {
            self.lost as f32 * 100.0 / self.sent as f32
        }
    }
    fn p(&self, q: f32) -> Option<f32> {
        if self.rtts.is_empty() {
            return None;
        }
        let mut v = self.rtts.clone();
        v.sort_by(f32::total_cmp);
        let i = ((v.len() - 1) as f32 * q).round() as usize;
        Some(v[i])
    }
    fn p50(&self) -> Option<f32> {
        self.p(0.5)
    }
    fn p95(&self) -> Option<f32> {
        self.p(0.95)
    }
    fn max(&self) -> Option<f32> {
        self.rtts.iter().copied().fold(None, |m: Option<f32>, v| Some(m.map_or(v, |m| m.max(v))))
    }
    fn jitter(&self) -> f32 {
        if self.jitter_n == 0 {
            0.0
        } else {
            (self.jitter_sum / self.jitter_n as f64) as f32
        }
    }
    /// Доля потерь цели в раундах, где этот хоп не ответил.
    fn dest_loss_when_lost(&self) -> Option<f32> {
        (self.lost > 0).then(|| self.lost_with_dest as f32 * 100.0 / self.lost as f32)
    }
}

/// Считает статистику по хопам и по цели, учитывая разрывы во времени (jitter не считается через дыру).
fn aggregate(samples: &[Sample], gap_ms: i64) -> (Vec<Agg>, Agg) {
    let mut hops: HashMap<u8, Agg> = HashMap::new();
    let mut dest = Agg::default();
    let mut prev_dest: Option<f32> = None;
    let mut prev_hop: HashMap<u8, f32> = HashMap::new();
    let mut prev_ts: Option<i64> = None;
    for s in samples {
        let gap = prev_ts.map_or(true, |p| s.ts - p > gap_ms);
        if gap {
            prev_dest = None;
            prev_hop.clear();
        }
        prev_ts = Some(s.ts);
        let dest_lost = s.rtt_ms.is_none();
        dest.sent += 1;
        match s.rtt_ms {
            None => {
                dest.lost += 1;
                prev_dest = None;
            }
            Some(v) => {
                dest.rtts.push(v);
                if let Some(p) = prev_dest {
                    dest.jitter_sum += (v - p).abs() as f64;
                    dest.jitter_n += 1;
                }
                prev_dest = Some(v);
            }
        }
        for h in &s.hops {
            let a = hops.entry(h.ttl).or_insert_with(|| Agg { ttl: h.ttl, ..Default::default() });
            a.sent += 1;
            if let Some(ip) = h.addr {
                a.addrs.insert(ip);
                a.last_addr = Some(ip);
            }
            match h.rtt_ms {
                None => {
                    a.lost += 1;
                    if dest_lost {
                        a.lost_with_dest += 1;
                    }
                    prev_hop.remove(&h.ttl);
                }
                Some(v) => {
                    a.ok_rounds += 1;
                    if dest_lost {
                        a.ok_dest_lost += 1;
                    }
                    a.rtts.push(v);
                    if let Some(p) = prev_hop.get(&h.ttl) {
                        a.jitter_sum += (v - p).abs() as f64;
                        a.jitter_n += 1;
                    }
                    prev_hop.insert(h.ttl, v);
                }
            }
        }
    }
    let mut list: Vec<Agg> = hops.into_values().collect();
    list.sort_by_key(|a| a.ttl);
    (list, dest)
}

/// Хоп, начиная с которого потери доходят до цели (для подсветки в таблице маршрута).
/// Возвращает None, если потери не подтверждаются совпадением по времени.
pub fn loss_origin(samples: &[Sample], gap_ms: i64) -> Option<u8> {
    let (hops, dest) = aggregate(samples, gap_ms);
    let dest_ttl = dest_ttl_of(samples);
    origin_hop(&hops, &dest, dest_ttl).map(|a| a.ttl)
}

/// TTL цели по последним успешным проверкам.
fn dest_ttl_of(samples: &[Sample]) -> Option<u8> {
    samples.iter().rev().find(|s| s.rtt_ms.is_some()).and_then(|s| s.hops.iter().rev().find(|h| h.rtt_ms.is_some()).map(|h| h.ttl))
}

/// Ищет хоп-источник потерь: потери начинаются с него, доходят до цели и совпадают по времени.
fn origin_hop<'a>(hops: &'a [Agg], dest: &Agg, dest_ttl: Option<u8>) -> Option<&'a Agg> {
    let dl = dest.loss_pct();
    if dl < 1.0 || dest.sent < 20 {
        return None;
    }
    let bar = (dl * 0.5).max(1.0);
    let mids: Vec<&Agg> = hops.iter().filter(|h| Some(h.ttl) != dest_ttl && h.sent >= 10).collect();
    for (i, h) in mids.iter().enumerate() {
        if h.loss_pct() < bar {
            continue;
        }
        // Совпадение по времени: когда хоп молчит, цель тоже молчит заметно чаще обычного.
        let coincide = h.dest_loss_when_lost().unwrap_or(0.0);
        if coincide < dl + 20.0 {
            continue; // потери хопа не связаны с потерями до цели — ограничение ICMP
        }
        if mids[i..].iter().all(|x| x.loss_pct() >= bar) {
            return Some(h);
        }
    }
    None
}

// ---------------------------------------------------------------- анализ

pub fn analyze(inp: &Input) -> Diagnosis {
    let s = inp.samples;
    let mut out: Vec<Finding> = vec![];
    let from = s.first().map_or(0, |x| x.ts);
    let to = s.last().map_or(0, |x| x.ts);
    let interval = inp.interval_ms.max(200) as i64;
    let gap_ms = interval * 3;

    if s.len() < 3 {
        return Diagnosis {
            level: Level::Info,
            summary: "Данных за период почти нет".into(),
            cause: None,
            findings: vec![f(
                Level::Info,
                Zone::General,
                Rule::Coverage,
                "",
                "Данных за период почти нет",
                format!("Проверок в окне анализа: {}. Для выводов нужно хотя бы несколько десятков.", s.len()),
                Some("Выберите период подлиннее или дождитесь, пока накопится история.".into()),
                None,
            )],
            from,
            to,
            samples: s.len(),
            coverage: 0.0,
            clamped: inp.clamped,
            stale: false,
        };
    }

    // Покрытие периода и разрывы: сон компьютера, закрытая программа, пауза цели.
    let expected = (((to - from) / interval) + 1).max(1) as f32;
    let coverage = (s.len() as f32 / expected).min(1.0);
    let gaps: Vec<(i64, i64)> = s.windows(2).filter(|w| w[1].ts - w[0].ts > gap_ms).map(|w| (w[0].ts, w[1].ts)).collect();
    let stale = inp.now - to > gap_ms.max(60_000);

    // Текущее состояние: хвост подряд неудачных проверок без разрыва во времени.
    let mut fail_tail = 0usize;
    let mut prev_ts = to;
    for x in s.iter().rev() {
        if x.rtt_ms.is_some() || prev_ts - x.ts > gap_ms {
            break;
        }
        fail_tail += 1;
        prev_ts = x.ts;
    }
    let down_after = inp.down_after.max(3);
    let down_now = fail_tail >= down_after && !stale;
    let outage_from = (fail_tail > 0).then(|| s[s.len() - fail_tail].ts);
    let outage_open = fail_tail == s.len(); // окно началось уже в аварии
    let before: &[Sample] = &s[..s.len() - fail_tail];

    if stale {
        out.push(f(
            Level::Info,
            Zone::General,
            Rule::Coverage,
            "",
            format!("Данные не обновлялись с {}", clock(to)),
            "Последняя проверка старше интервала — цель на паузе, программа была закрыта или компьютер спал.".to_string(),
            None,
            None,
        ));
    }
    if !gaps.is_empty() && coverage < 0.9 {
        let longest = gaps.iter().map(|(a, b)| b - a).max().unwrap_or(0);
        out.push(f(
            Level::Info,
            Zone::General,
            Rule::Coverage,
            "",
            format!("В данных есть перерывы: покрытие периода {:.0}%", coverage * 100.0),
            format!(
                "{} без проверок, самый длинный — {} мин. Обычно это сон компьютера, закрытая программа или пауза цели.",
                plural(gaps.len(), "перерыв", "перерыва", "перерывов"),
                (longest / 60_000).max(1)
            ),
            Some("Потери и аптайм за такой период занижены: пропущенное время в расчёт не входит.".into()),
            None,
        ));
    }

    // 1. Сеть самого компьютера мониторинга.
    if let Some((failing, total, distinct)) = inp.monitor_wide {
        if total >= 4 && failing * 10 >= total * 6 && (distinct >= 2 || failing == total) {
            out.push(f(
                Level::Crit,
                Zone::Monitor,
                Rule::Availability,
                "не отвечает большинство целей — проверьте свой канал",
                "Одновременно не отвечает большинство целей",
                format!("Сейчас не отвечают {failing} из {total} целей, и они идут разными маршрутами."),
                Some("Сначала проверьте свой канал: шлюз, Wi-Fi, VPN. Если шлюз отвечает, проблема выше — у провайдера. После сна ноутбука это нормально: через минуту проверки восстановятся.".into()),
                None,
            ));
        }
    }
    // 2. Вышестоящий узел по зависимости.
    if let Some(p) = &inp.parent_failing {
        if down_now {
            out.push(f(
                Level::Crit,
                Zone::Parent,
                Rule::Availability,
                format!("недоступен вышестоящий «{p}»"),
                format!("Недоступен вышестоящий узел «{p}»"),
                "Цель находится за ним, поэтому её недоступность — следствие.",
                Some(format!("Разбирайтесь с «{p}»: пока он недоступен, уведомления по этой цели не отправляются.")),
                None,
            ));
        }
    }

    if stale {
        // Данные устарели: выводы о текущем состоянии делать нельзя.
        return Diagnosis {
            level: Level::Info,
            summary: out.first().map(|x| x.title.clone()).unwrap_or_else(|| "Данные устарели".into()),
            cause: None,
            findings: out,
            from,
            to,
            samples: s.len(),
            coverage,
            clamped: inp.clamped,
            stale,
        };
    }

    match inp.kind {
        CheckKind::Trace | CheckKind::Ping => analyze_icmp(inp, down_now, outage_from, outage_open, fail_tail, before, gap_ms, &mut out),
        CheckKind::Http => analyze_http(inp, down_now, &mut out),
        CheckKind::Tcp => analyze_tcp(inp, down_now, &mut out),
        CheckKind::Dns => analyze_dns(inp, down_now, &mut out),
    }

    // Общие наблюдения.
    if inp.flaps_hour >= 3 {
        out.push(f(
            Level::Warn,
            Zone::General,
            Rule::Flaps,
            format!("{} за час", plural(inp.flaps_hour, "обрыв", "обрыва", "обрывов")),
            format!("Нестабильная связь: {} за последний час", plural(inp.flaps_hour, "завершённый обрыв", "завершённых обрыва", "завершённых обрывов")),
            "Узел пропадает на несколько секунд и возвращается.",
            Some("Так ведут себя нестабильные каналы (радио, перегруженный или подгорающий порт, плохой контакт), перезагрузки оборудования и частая смена маршрута.".into()),
            None,
        ));
    }
    if let Some((ts, msg)) = &inp.ip_change {
        let related = outage_from.map_or(false, |o| (o - ts).abs() < 10 * 60_000);
        out.push(f(
            if related { Level::Warn } else { Level::Info },
            Zone::Target,
            Rule::Route,
            "у цели сменился IP",
            format!("В {} у цели сменился IP-адрес", clock(*ts)),
            msg.clone(),
            Some(if related {
                "Проблема совпала со сменой адреса: возможно, мониторится старый адрес или у цели несколько серверов с разной доступностью.".into()
            } else {
                "Для имён с несколькими адресами (CDN, балансировка) маршрут и результаты будут меняться.".to_string()
            }),
            None,
        ));
    }
    if let Some((ts, msg)) = &inp.route_change {
        let related = outage_from.map_or(false, |o| (o - ts).abs() < 10 * 60_000);
        out.push(f(
            if related { Level::Warn } else { Level::Info },
            Zone::General,
            Rule::Route,
            "менялся маршрут",
            format!("В {} менялся маршрут{}", clock(*ts), if related { " — незадолго до проблемы" } else { "" }),
            msg.clone(),
            related.then(|| "Проблема могла начаться из-за перестроения маршрута у оператора.".to_string()),
            None,
        ));
    }
    if !inp.peak_hours.is_empty() {
        let hours: Vec<String> = inp.peak_hours.iter().map(|h| format!("{h:02}:00")).collect();
        out.push(f(
            Level::Info,
            Zone::General,
            Rule::Note,
            "",
            format!("Проблемы повторяются в одни и те же часы: {}", hours.join(", ")),
            "В эти часы в разные дни растут потери или задержка.".to_string(),
            Some("Похоже на перегрузку канала в часы пик, резервное копирование или задачи по расписанию.".into()),
            None,
        ));
    }

    // Порядок: уровень → зона → тип правила.
    out.sort_by(|a, b| b.level.cmp(&a.level).then(a.zone.prio().cmp(&b.zone.prio())).then(a.rule.cmp(&b.rule)));

    let level = out.first().map_or(Level::Ok, |x| x.level);
    let notes = out.iter().filter(|x| x.level == Level::Info).count();
    if level <= Level::Info {
        let (title, detail) = if notes > 0 {
            ("Явных проблем нет, есть замечания".to_string(), format!("Проверок в окне: {}. Потери и задержка в пределах порогов цели.", s.len()))
        } else {
            ("Проблем не найдено".to_string(), format!("Узел отвечает стабильно, проверок в окне: {}.", s.len()))
        };
        out.insert(0, f(Level::Ok, Zone::General, Rule::Note, "", title, detail, None, None));
    }
    // Короткая причина: конкретный участок важнее общего замечания про локальную сеть.
    let top = out
        .iter()
        .find(|x| x.level >= Level::Warn && !x.short.is_empty() && !(x.zone == Zone::Local && x.level == Level::Warn))
        .or_else(|| out.iter().find(|x| x.level >= Level::Warn && !x.short.is_empty()));
    Diagnosis {
        level: if level <= Level::Info { Level::Ok } else { level },
        summary: out.first().map(|x| x.title.clone()).unwrap_or_default(),
        cause: top.map(|x| x.short.clone()),
        findings: out,
        from,
        to,
        samples: s.len(),
        coverage,
        clamped: inp.clamped,
        stale,
    }
}

/// Есть ли рядом живая проверка того же адреса другим способом.
fn service_alive<'a>(inp: &'a Input) -> Option<&'a SameHost> {
    inp.same_host.iter().find(|x| x.ok && matches!(x.kind, CheckKind::Tcp | CheckKind::Http))
}

#[allow(clippy::too_many_arguments)]
fn analyze_icmp(inp: &Input, down_now: bool, outage_from: Option<i64>, outage_open: bool, fail_tail: usize, before: &[Sample], gap_ms: i64, out: &mut Vec<Finding>) {
    let s = inp.samples;
    let names = inp.hostnames;
    let last = s.last().unwrap();
    let dest_ttl = dest_ttl_of(s);
    let target_ip: Option<IpAddr> = inp
        .host
        .parse()
        .ok()
        .or_else(|| s.iter().rev().find_map(|x| x.hops.iter().rev().find(|h| h.rtt_ms.is_some()).and_then(|h| h.addr)));
    let target_private = target_ip.map_or(false, |ip| is_private(&ip));

    // Ошибки, при которых пакеты вообще не отправлялись.
    if down_now {
        if let Some(e) = &last.error {
            let el = e.to_lowercase();
            if el.contains("разрешить имя") || el.contains("resolve") {
                out.push(f(
                    Level::Crit,
                    Zone::Monitor,
                    Rule::Availability,
                    "не определяется IP по имени",
                    format!("Не удаётся определить IP по имени {}", inp.host),
                    e.clone(),
                    Some("Проверьте DNS на этом компьютере и существование записи. Если имя верное — проблема у DNS-сервера, а не у цели.".into()),
                    None,
                ));
                return;
            }
            if el.contains("icmp недоступен") {
                out.push(f(Level::Crit, Zone::Monitor, Rule::Availability, "ICMP недоступен", "Программа не может отправлять ICMP-пакеты", e.clone(), Some("Проверьте права приложения и настройки файрвола на этом компьютере.".into()), None));
                return;
            }
            // Ответ «недоступен» разбираем по коду ICMP: причины у них разные.
            if el.contains("нет маршрута до сети") {
                out.push(f(
                    Level::Crit,
                    Zone::General,
                    Rule::Availability,
                    "нет маршрута до сети цели",
                    "Маршрутизатор отвечает: нет маршрута до сети",
                    e.clone(),
                    Some("Ответил маршрутизатор, указанный в скобках. Проверьте на нём маршрут до этой сети: не удалён ли маршрут, поднят ли туннель, анонсируется ли префикс.".into()),
                    None,
                ));
                return;
            }
            if el.contains("нет arp") {
                out.push(f(
                    Level::Crit,
                    Zone::Dest,
                    Rule::Availability,
                    "узел не отвечает в своей сети (нет ARP)",
                    "Сеть до узла есть, сам узел не отвечает",
                    e.clone(),
                    Some("Маршрутизатор дошёл до сети узла, но узел не отвечает на ARP: он выключен, отключён от коммутатора или сменил адрес. Проверьте ARP и MAC-таблицу на этом маршрутизаторе.".into()),
                    None,
                ));
                return;
            }
            if el.contains("запрещено административно") {
                out.push(f(
                    Level::Crit,
                    Zone::General,
                    Rule::Availability,
                    "трафик запрещён фильтром",
                    "Пакеты отбрасывает фильтр на маршрутизаторе",
                    e.clone(),
                    Some("Маршрутизатор из скобок отвечает «запрещено административно» — это ACL или файрвол на пути, а не отказ самого узла.".into()),
                    None,
                ));
                return;
            }
            if el.contains("больше mtu") {
                out.push(f(
                    Level::Crit,
                    Zone::General,
                    Rule::Availability,
                    "не проходит из-за MTU",
                    "Пакет не проходит: нужен меньший MTU",
                    e.clone(),
                    Some("На участке меньший MTU, а фрагментация запрещена. Уменьшите размер пакета в настройках цели и проверьте MTU и MSS на туннеле.".into()),
                    None,
                ));
                return;
            }
            if el.contains("порт закрыт") {
                out.push(f(Level::Crit, Zone::Target, Rule::Availability, "порт закрыт", "Узел отвечает, что порт закрыт", e.clone(), Some("Узел жив, служба на этом порту не слушает.".into()), None));
                return;
            }
            if el.contains("ответ маршрутизатора") {
                out.push(f(
                    Level::Crit,
                    Zone::Dest,
                    Rule::Availability,
                    "маршрутизатор сообщает: узел недоступен",
                    "Маршрутизатор сообщает, что узел недоступен",
                    e.clone(),
                    Some("Ответил ближайший к цели маршрутизатор. Посмотрите на нём таблицу ARP и маршруты.".into()),
                    None,
                ));
                return;
            }
            if el.contains("ttl истёк") {
                out.push(f(Level::Crit, Zone::General, Rule::Availability, "петля маршрутизации", "Пакеты не доходят: истекает TTL", e.clone(), Some("Похоже на петлю или слишком длинный маршрут. Посмотрите таблицы маршрутизации на участке.".into()), None));
                return;
            }
        }
    }
    if let Some(e) = &inp.resolve_error {
        out.push(f(Level::Warn, Zone::Monitor, Rule::Availability, "сбой резолва имени", "Имя цели резолвится с ошибкой", e.clone(), Some("Используется последний известный адрес. Проверьте DNS-сервер этого компьютера.".into()), None));
    }

    let (hops_all, _) = aggregate(s, gap_ms);
    let route: Vec<(u8, Option<IpAddr>)> = hops_all.iter().map(|h| (h.ttl, h.last_addr)).collect();
    // Для зоны используем и сохранённый рабочий маршрут: молчащий сейчас хоп мог отвечать раньше.
    let mut route_zone = route.clone();
    for (ttl, addr) in inp.known_route {
        match route_zone.iter_mut().find(|(t, _)| t == ttl) {
            Some(e) => {
                if e.1.is_none() {
                    e.1 = *addr;
                }
            }
            None => route_zone.push((*ttl, *addr)),
        }
    }
    route_zone.sort_by_key(|(t, _)| *t);
    let zones = classify(&route_zone, dest_ttl, names, target_private);
    let zone_of = |ttl: u8| zones.iter().find(|z| z.ttl == ttl).map(|z| (z.zone, z.org.clone())).unwrap_or((Zone::General, None));
    let addr_of = |ttl: u8| route_zone.iter().find(|(t, _)| *t == ttl).and_then(|(_, a)| *a);
    let label = |ttl: u8| match addr_of(ttl) {
        Some(ip) => match names.get(&ip) {
            Some(n) => format!("{ttl} ({ip}, {n})"),
            None => format!("{ttl} ({ip})"),
        },
        None => format!("{ttl} (адрес неизвестен)"),
    };

    if down_now {
        let since = match (outage_from, outage_open) {
            (Some(t), false) => format!(" с {}", clock(t)),
            (Some(t), true) => format!(" не позднее чем с {}", clock(t)),
            _ => String::new(),
        };
        let alive = service_alive(inp);
        if inp.kind == CheckKind::Ping || last.hops.is_empty() {
            let (level, title, detail, hint) = match alive {
                Some(sh) => (
                    Level::Warn,
                    format!("Узел не отвечает на ping{since}, но сервис работает"),
                    format!("Проверка «{}» ({}) к этому же адресу проходит.", sh.name, kind_name(sh.kind)),
                    "ICMP до узла фильтруется (файрвол на узле или перед ним). Сам сервис доступен — как аварию это считать не нужно.".to_string(),
                ),
                None => (
                    Level::Crit,
                    format!("Узел не отвечает{since}"),
                    format!("Подряд без ответа: {}.", plural(fail_tail, "проверка", "проверки", "проверок")),
                    if target_private {
                        "Узел во внутренней сети: проверьте маршрутизатор и туннель до этой площадки. Чтобы увидеть, где обрывается путь, добавьте к адресу трассировку.".to_string()
                    } else {
                        "Без трассировки нельзя отличить выключенный узел от недоступной сети — добавьте к этому адресу проверку типа «трассировка».".to_string()
                    },
                ),
            };
            let zone = if alive.is_some() { Zone::Target } else { Zone::General };
            out.push(f(level, zone, Rule::Availability, if alive.is_some() { "ICMP фильтруется, сервис отвечает" } else { "не отвечает на ping" }, title, detail, Some(hint), None));
            return;
        }
        let tail = &s[s.len() - fail_tail..];
        let (cur, _) = aggregate(tail, gap_ms);
        // Хопы, которые молчат всегда (MPLS, фильтр ICMP), не считаем точкой обрыва.
        let always_silent: HashSet<u8> = hops_all.iter().filter(|h| h.ok_rounds == 0 && h.sent >= 5).map(|h| h.ttl).collect();
        let responding: Vec<&Agg> = cur.iter().filter(|h| h.ok_rounds > 0 && Some(h.ttl) != dest_ttl).collect();
        match responding.last() {
            None => {
                out.push(f(
                    Level::Crit,
                    Zone::Local,
                    Rule::Availability,
                    "не отвечает даже первый хоп",
                    format!("Нет ответа ни от одного хопа{since}"),
                    "Не отвечает даже первый маршрутизатор — пакеты не уходят дальше этого компьютера или его шлюза.",
                    Some(zone_hint(Zone::Local).into()),
                    Some(1),
                ));
            }
            Some(lh) => {
                let (lz, lorg) = zone_of(lh.ttl);
                // Следующий за ним хоп, который не молчит всегда.
                let next_ttl = (lh.ttl + 1..=dest_ttl.unwrap_or(lh.ttl + 1)).find(|t| !always_silent.contains(t)).unwrap_or(lh.ttl + 1);
                let reaches_last = dest_ttl.map_or(false, |d| next_ttl >= d);
                if reaches_last {
                    let was_ok = before.iter().any(|x| x.rtt_ms.is_some());
                    let alive = service_alive(inp);
                    match alive {
                        Some(sh) => out.push(f(
                            Level::Warn,
                            Zone::Target,
                            Rule::Availability,
                            "ICMP фильтруется, сервис отвечает",
                            format!("Узел не отвечает на ICMP{since}, но сервис работает"),
                            format!("Трассировка доходит до хопа {} — последнего маршрутизатора перед целью. Проверка «{}» ({}) к этому же адресу проходит.", label(lh.ttl), sh.name, kind_name(sh.kind)),
                            Some("ICMP закрыт на узле или на маршрутизаторе перед ним. Для контроля доступности используйте проверку сервиса, а не ping.".into()),
                            dest_ttl,
                        )),
                        None => out.push(f(
                            Level::Crit,
                            Zone::Target,
                            Rule::Availability,
                            "ICMP доходит до соседнего маршрутизатора, узел молчит",
                            format!("Сеть доходит до последнего маршрутизатора перед целью, узел не отвечает{since}"),
                            format!(
                                "ICMP доходит до хопа {} ({}).{}",
                                label(lh.ttl),
                                zone_name(lz, &lorg),
                                if was_ok { " До этого узел отвечал нормально." } else { "" }
                            ),
                            Some("Узел выключен, завис, сменил адрес или ICMP закрыт файрволом. Добавьте к этому же адресу проверку TCP-порта сервиса — она отличит выключенный узел от закрытого ICMP.".into()),
                            dest_ttl,
                        )),
                    }
                    share_hint(inp, addr_of(lh.ttl), out);
                } else {
                    let (nz, norg) = {
                        let z = zone_of(next_ttl);
                        if z.0 == Zone::General || z.0 == Zone::Target {
                            (lz, lorg.clone())
                        } else {
                            z
                        }
                    };
                    let unknown_next = addr_of(next_ttl).is_none();
                    out.push(f(
                        Level::Crit,
                        if unknown_next { Zone::General } else { nz },
                        Rule::Availability,
                        if unknown_next {
                            format!("обрыв после хопа {} — оператор не определён", lh.ttl)
                        } else {
                            format!("обрыв после хопа {} — {}", lh.ttl, zone_name(nz, &norg))
                        },
                        format!("Трассировка обрывается после хопа {}{since}", lh.ttl),
                        if unknown_next {
                            format!("Последний ответивший — хоп {}. Следующий хоп не отвечал и раньше, поэтому оператора участка определить нельзя.", label(lh.ttl))
                        } else {
                            format!("Последний ответивший — хоп {}. Дальше ответов нет: обрыв на участке {} → {}, зона: {}.", label(lh.ttl), lh.ttl, next_ttl, zone_name(nz, &norg))
                        },
                        Some(if unknown_next {
                            "Сравните с другими целями через этот же участок и приложите трассировку к заявке провайдеру.".to_string()
                        } else {
                            zone_hint(nz).to_string()
                        }),
                        Some(next_ttl),
                    ));
                    share_hint(inp, addr_of(lh.ttl), out);
                }
            }
        }
        if !before.is_empty() {
            quality(inp, before, dest_ttl, &zones, gap_ms, out, true);
        }
        return;
    }

    quality(inp, s, dest_ttl, &zones, gap_ms, out, false);
}

fn kind_name(k: CheckKind) -> &'static str {
    match k {
        CheckKind::Trace => "трассировка",
        CheckKind::Ping => "ping",
        CheckKind::Http => "HTTP",
        CheckKind::Tcp => "TCP-порт",
        CheckKind::Dns => "DNS",
    }
}

/// Потери, задержка и jitter: где начинаются и влияют ли на цель.
fn quality(inp: &Input, s: &[Sample], dest_ttl: Option<u8>, zones: &[HopZone], gap_ms: i64, out: &mut Vec<Finding>, after_outage: bool) {
    let names = inp.hostnames;
    let th = inp.th;
    let (hops, dest) = aggregate(s, gap_ms);
    if dest.sent < 10 {
        return;
    }
    let zone_of = |ttl: u8| zones.iter().find(|z| z.ttl == ttl).map(|z| (z.zone, z.org.clone())).unwrap_or((Zone::General, None));
    let label = |a: &Agg| match a.last_addr {
        Some(ip) => match names.get(&ip) {
            Some(n) => format!("{} ({ip}, {n})", a.ttl),
            None => format!("{} ({ip})", a.ttl),
        },
        None => format!("{}", a.ttl),
    };
    let prefix = if after_outage { "До обрыва: " } else { "" };
    let mids: Vec<&Agg> = hops.iter().filter(|h| Some(h.ttl) != dest_ttl && h.sent >= 10 && h.ok_rounds > 0).collect();
    let dest_loss = dest.loss_pct();
    let is_trace = inp.kind == CheckKind::Trace;
    let enough = dest.sent >= 30;

    // Балансировка: на одном TTL несколько адресов — статистика по нему смешана.
    if let Some(h) = mids.iter().find(|h| h.addrs.len() > 1) {
        out.push(f(
            Level::Info,
            Zone::General,
            Rule::Note,
            "",
            format!("На хопе {} несколько маршрутов (балансировка)", h.ttl),
            format!("В окне анализа отвечали разные адреса: {}. Средние по этому хопу смешаны и не показывают деградацию.", h.addrs.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", ")),
            None,
            Some(h.ttl),
        ));
    }
    // Хопы, которые не отвечают никогда: MPLS или фильтр ICMP, а не обрыв.
    let silent: Vec<&Agg> = hops.iter().filter(|h| Some(h.ttl) != dest_ttl && h.ok_rounds == 0 && h.sent >= 10).collect();
    if !silent.is_empty() && dest.rtts.len() > 5 {
        let list = silent.iter().map(|h| h.ttl.to_string()).collect::<Vec<_>>().join(", ");
        out.push(f(
            Level::Info,
            Zone::General,
            Rule::Note,
            "",
            format!("Хопы {list} не отвечают на ICMP, но трасса идёт дальше"),
            "Так выглядят MPLS-туннели и маршрутизаторы с закрытым ICMP. Это не обрыв.".to_string(),
            None,
            None,
        ));
    }

    // --- Потери
    if dest_loss > 0.5 && is_trace {
        let origin = origin_hop(&hops, &dest, dest_ttl);
        let confident = enough && dest.lost >= 5;
        let lvl = if dest_loss as f64 > th.warn_loss && confident { Level::Warn } else { Level::Info };
        let note = if confident { String::new() } else { format!(" (данных мало: {} из {} проверок)", dest.lost, dest.sent) };
        match origin {
            Some(h) => {
                let (z, org) = zone_of(h.ttl);
                out.push(f(
                    lvl,
                    z,
                    Rule::Loss,
                    format!("потери {} с хопа {} — {}", pct(dest_loss), h.ttl, zone_name(z, &org)),
                    pre(prefix, format!("Потери {} начинаются на хопе {}", pct(dest_loss), h.ttl)),
                    format!("С хопа {} потери совпадают по времени с потерями до цели и доходят до неё{note}. Зона: {}.", label(h), zone_name(z, &org)),
                    Some(zone_hint(z).into()),
                    Some(h.ttl),
                ));
                share_hint(inp, h.last_addr, out);
            }
            None => {
                let prev = mids.last();
                match prev {
                    Some(p) if p.loss_pct() < 1.0 && dest_ttl.is_some() => out.push(f(
                        lvl,
                        Zone::Target,
                        Rule::Loss,
                        format!("потери {} только на самой цели", pct(dest_loss)),
                        pre(prefix, format!("Потери {} только на самой цели", pct(dest_loss))),
                        format!("Последний маршрутизатор перед целью (хоп {}) отвечает без потерь{note}.", label(p)),
                        Some("Узел перегружен, ограничивает ответы на ICMP, либо теряет последний линк до него. Добавьте к этому адресу проверку TCP-порта сервиса — она отделит фильтрацию ICMP от реальных потерь.".into()),
                        dest_ttl,
                    )),
                    _ => out.push(f(
                        lvl,
                        Zone::General,
                        Rule::Loss,
                        format!("потери {}", pct(dest_loss)),
                        pre(prefix, format!("Потери до цели {}", pct(dest_loss))),
                        format!("Промежуточные хопы не дают однозначной точки начала потерь{note}."),
                        Some("Маршрутизаторы на пути могут ограничивать ICMP, из-за чего источник потерь не виден. Сравните с соседними целями через тот же участок.".into()),
                        None,
                    )),
                }
            }
        }
    } else if dest_loss as f64 > th.warn_loss && !is_trace && enough {
        out.push(f(
            Level::Warn,
            Zone::Target,
            Rule::Loss,
            format!("потери {}", pct(dest_loss)),
            pre(prefix, format!("Потери {} до узла", pct(dest_loss))),
            format!("Без ответа: {} из {} проверок.", dest.lost, dest.sent),
            Some("Добавьте к этому адресу трассировку — она покажет, на каком участке теряются пакеты.".into()),
            None,
        ));
    }

    // Потери на промежуточном хопе, не связанные по времени с потерями до цели.
    let origin_ttl = origin_hop(&hops, &dest, dest_ttl).map(|h| h.ttl);
    if let Some(h) = mids
        .iter()
        .filter(|h| Some(h.ttl) != origin_ttl && h.loss_pct() >= 10.0 && h.dest_loss_when_lost().unwrap_or(0.0) < dest_loss + 20.0)
        .max_by(|a, b| a.loss_pct().total_cmp(&b.loss_pct()))
    {
        out.push(f(
            Level::Info,
            Zone::General,
            Rule::Note,
            "",
            format!("Потери {} на хопе {} — не влияют на цель", pct(h.loss_pct()), h.ttl),
            format!("На хопе {} теряются ответы, но потери до цели с ними не совпадают: {} против {} у цели.", label(h), pct(h.loss_pct()), pct(dest_loss)),
            Some("Маршрутизатор ограничивает частоту ответов на ICMP. Транзитный трафик через него идёт нормально.".into()),
            Some(h.ttl),
        ));
    }

    // --- Локальный участок: первый хоп.
    if let Some(h1) = hops.iter().find(|h| h.ttl == 1 && h.sent >= 20 && Some(1) != dest_ttl) {
        let j = h1.jitter();
        let noisy = h1.loss_pct() >= 2.0 || j >= 8.0;
        let dest_bad = dest_loss as f64 > th.warn_loss || (th.jitter_warn > 0.0 && dest.jitter() as f64 >= th.jitter_warn);
        if noisy {
            let parts = [(h1.loss_pct() >= 2.0).then(|| format!("потери {}", pct(h1.loss_pct()))), (j >= 8.0).then(|| format!("jitter {j:.1} мс"))]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(", ");
            if dest_bad {
                out.push(f(
                    Level::Warn,
                    Zone::Local,
                    Rule::Loss,
                    "нестабилен первый хоп (шлюз или Wi-Fi)",
                    pre(prefix, "Нестабилен первый участок — ваш шлюз или Wi-Fi".to_string()),
                    format!("На хопе {}: {}. У цели тоже есть потери или колебания задержки, то есть это влияет на результат.", label(h1), parts),
                    Some("Если компьютер на Wi-Fi, подключите кабель и перепроверьте: иначе все цели будут выглядеть хуже, чем есть.".into()),
                    Some(1),
                ));
            } else {
                out.push(f(
                    Level::Info,
                    Zone::Local,
                    Rule::Note,
                    "",
                    format!("Первый хоп отвечает нерегулярно ({parts})"),
                    "До цели при этом потерь и колебаний нет — домашние и офисные маршрутизаторы часто отвечают на ICMP по остаточному принципу.".to_string(),
                    None,
                    Some(1),
                ));
            }
        }
    }

    // --- Задержка: по медиане, порог — «оранжевый» уровень цели.
    let Some(dp50) = dest.p50() else { return };
    let latency_on = th.bad_ms.is_finite() && th.bad_ms > 0.0 && inp.kind != CheckKind::Http;
    if latency_on && dp50 as f64 > th.bad_ms && enough {
        if is_trace {
            // Хоп, на котором задержка прибавляется и не исчезает дальше.
            let mut best: Option<(&Agg, f32)> = None;
            let mut base = 0.0f32;
            for (i, h) in mids.iter().enumerate() {
                let Some(p) = h.p50() else { continue };
                if h.addrs.len() > 1 {
                    continue; // балансировка — статистика смешана
                }
                let delta = p - base;
                let persists = mids[i..].iter().filter_map(|x| x.p50()).all(|x| x >= p * 0.7) && dp50 >= p * 0.7;
                if persists && delta >= (dp50 * 0.3).max(10.0) && best.map_or(true, |(_, d)| delta > d) {
                    best = Some((h, delta));
                }
                base = base.max(p.min(dp50));
            }
            match best {
                Some((h, delta)) => {
                    let (z, org) = zone_of(h.ttl);
                    // Перегрузка — когда вместе с задержкой растёт и разброс у самой цели.
                    let dest_spread = dest.p95().unwrap_or(dp50) - dp50;
                    let congested = dest_spread > dp50 * 0.3 && dest.jitter() > (dp50 * 0.1).max(2.0);
                    let (title, hint) = if congested {
                        (
                            pre(prefix, format!("Задержка растёт на хопе {} и нестабильна", h.ttl)),
                            format!(
                                "Разброс у цели: медиана {dp50:.0} мс, 95-й процентиль {:.0} мс, jitter {:.1} мс — похоже на перегрузку участка. {}",
                                dest.p95().unwrap_or(dp50),
                                dest.jitter(),
                                zone_hint(z)
                            ),
                        )
                    } else {
                        (
                            pre(prefix, format!("Задержка стабильно прибавляет +{delta:.0} мс на хопе {}", h.ttl)),
                            "Ровная прибавка без роста разброса — это расстояние или маршрут через другой город, а не деградация. Если раньше было быстрее, сравните с историей: маршрут могли перестроить.".to_string(),
                        )
                    };
                    let asym = mids.iter().find(|x| x.ttl > h.ttl).and_then(|x| x.p50()).map_or(false, |next| next + 5.0 < h.p50().unwrap_or(0.0));
                    let detail = format!(
                        "Медиана до цели {dp50:.0} мс (порог {:.0}). Прибавка появляется на хопе {}: {}.{}",
                        th.bad_ms,
                        label(h),
                        zone_name(z, &org),
                        if asym { " На следующих хопах задержка ниже — вероятно, дело в обратном маршруте этого хопа, а не в участке." } else { "" }
                    );
                    out.push(f(Level::Warn, z, Rule::Latency, format!("задержка растёт с хопа {} — {}", h.ttl, zone_name(z, &org)), title, detail, Some(hint), Some(h.ttl)));
                }
                None => out.push(f(
                    Level::Warn,
                    Zone::Target,
                    Rule::Latency,
                    format!("задержка {dp50:.0} мс"),
                    pre(prefix, format!("Высокая задержка до цели: {dp50:.0} мс")),
                    format!("Промежуточные хопы быстрее, прибавка набирается на последнем участке (порог {:.0} мс).", th.bad_ms),
                    Some("Узел или его канал перегружены — проверьте загрузку узла и его аплинка.".into()),
                    dest_ttl,
                )),
            }
        } else {
            out.push(f(
                Level::Warn,
                Zone::Target,
                Rule::Latency,
                format!("задержка {dp50:.0} мс"),
                pre(prefix, format!("Высокая задержка: {dp50:.0} мс (порог {:.0})", th.bad_ms)),
                "Для поиска участка добавьте к этому адресу трассировку.".to_string(),
                None,
                None,
            ));
        }
    }

    // Всплески на промежуточном хопе, которых нет у цели.
    if let Some(h) = mids
        .iter()
        .filter(|h| h.max().unwrap_or(0.0) > dp50 * 5.0 + 50.0 && h.p50().map_or(false, |p| p < dp50 * 1.5 + 5.0))
        .max_by(|a, b| a.max().unwrap_or(0.0).total_cmp(&b.max().unwrap_or(0.0)))
    {
        out.push(f(
            Level::Info,
            Zone::General,
            Rule::Note,
            "",
            format!("Всплески до {:.0} мс на хопе {} — не влияют на цель", h.max().unwrap_or(0.0), h.ttl),
            format!("Медиана этого хопа {:.0} мс, у цели {dp50:.0} мс — отдельные ответы задерживаются, сквозная задержка ровная.", h.p50().unwrap_or(0.0)),
            Some("Маршрутизатор отвечает на ICMP с низким приоритетом, когда занят. На транзитный трафик это не влияет.".into()),
            Some(h.ttl),
        ));
    }

    // --- Jitter (важен для голоса и видео).
    let dj = dest.jitter();
    if th.jitter_warn > 0.0 && dj as f64 >= th.jitter_warn && enough {
        let origin = mids.iter().enumerate().find(|(i, h)| {
            let j = h.jitter();
            let prev = if *i == 0 { 0.0 } else { mids[i - 1].jitter() };
            j >= dj && j - prev >= dj * 0.5 && mids[*i..].iter().all(|x| x.jitter() >= dj * 0.7)
        });
        let (z, org, ttl) = origin
            .map(|(_, h)| {
                let (z, o) = zone_of(h.ttl);
                (z, o, Some(h.ttl))
            })
            .unwrap_or((Zone::Target, None, None));
        out.push(f(
            Level::Warn,
            z,
            Rule::Jitter,
            format!("jitter {dj:.0} мс — {}", zone_name(z, &org)),
            pre(prefix, format!("Колебания задержки {dj:.1} мс — выше порога {:.0} мс", th.jitter_warn)),
            match ttl {
                Some(t) => format!("Колебания появляются с хопа {t}, зона: {}.", zone_name(z, &org)),
                None => "Точку начала колебаний по хопам определить не удалось: промежуточные маршрутизаторы отвечают нестабильно сами по себе.".to_string(),
            },
            Some("Для голоса нужен jitter до 20–30 мс. Обычная причина — перегрузка канала или Wi-Fi; помогает приоритизация голосового трафика (QoS).".into()),
            ttl,
        ));
    }
}

/// Общий участок маршрута с другими целями.
fn share_hint(inp: &Input, hop: Option<IpAddr>, out: &mut Vec<Finding>) {
    let Some(ip) = hop else { return };
    let same: Vec<&OtherRoute> = inp.others.iter().filter(|o| o.route.contains(&ip)).collect();
    if same.is_empty() {
        return;
    }
    let bad: Vec<&str> = same.iter().filter(|o| o.failing).map(|o| o.name.as_str()).collect();
    if bad.is_empty() {
        // Сообщаем только когда целей через этот хоп заметно много — иначе вывод ни о чём.
        if same.len() >= 3 {
            out.push(f(
                Level::Info,
                Zone::General,
                Rule::Note,
                "",
                format!("Через {ip} идут ещё {} — они отвечают", plural(same.len(), "цель", "цели", "целей")),
                "Значит, участок до этого хопа работает, а проблема дальше по маршруту к этой цели.".to_string(),
                None,
                None,
            ));
        }
    } else {
        let list = bad.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
        out.push(f(
            Level::Info,
            Zone::General,
            Rule::Note,
            "",
            format!("Через {ip} идут ещё {}, у {} тоже проблемы", plural(same.len(), "цель", "цели", "целей"), bad.len()),
            format!("Сейчас недоступны: {list}{}. Похоже на общую причину на этом участке, а не на проблему одной цели.", if bad.len() > 5 { " и другие" } else { "" }),
            None,
            None,
        ));
    }
}

fn top_error(s: &[Sample]) -> Option<(String, usize)> {
    let mut m: HashMap<String, usize> = HashMap::new();
    for x in s.iter().filter(|x| x.error.is_some()) {
        *m.entry(x.error.clone().unwrap()).or_insert(0) += 1;
    }
    m.into_iter().max_by_key(|(_, v)| *v)
}

/// Разбор ошибки соединения (HTTP/TCP).
fn explain_conn(e: &str, timeout_ms: u64) -> Option<(Zone, &'static str, String, String)> {
    let l = e.to_lowercase();
    if l.contains("handshake") || l.contains("eof") || l.contains("reset") || l.contains("сброс") {
        return Some((
            Zone::Target,
            "соединение обрывается",
            "Соединение обрывается до ответа".into(),
            "Сервер или промежуточный фильтр (DPI, WAF) разрывает соединение. Проверьте, доступен ли адрес с другой сети.".into(),
        ));
    }
    if l.contains("certificate") || l.contains("сертификат") || l.contains("tls") || l.contains("ssl") {
        let why = if l.contains("expired") {
            "истёк срок действия сертификата"
        } else if l.contains("not valid for") || l.contains("notvalidforname") {
            "сертификат выдан на другое имя"
        } else if l.contains("unknownissuer") || l.contains("self") || l.contains("unknown issuer") {
            "сертификат не доверенный: самоподписанный или неполная цепочка"
        } else {
            "ошибка TLS-рукопожатия"
        };
        return Some((Zone::Target, "проблема TLS-сертификата", format!("Проблема с TLS: {why}"), "Сеть до узла работает. Обновите сертификат и убедитесь, что сервер отдаёт полную цепочку.".into()));
    }
    if l.contains("dns") || l.contains("lookup") || l.contains("resolve") || l.contains("разрешить") {
        return Some((Zone::Monitor, "не определяется IP по имени", "Не удаётся определить IP по имени".into(), "Проверьте DNS этого компьютера и наличие записи для домена.".into()));
    }
    if l.contains("refused") || l.contains("отклон") {
        return Some((
            Zone::Target,
            "порт закрыт (connection refused)",
            "Соединение отклонено: узел доступен, сервис на порту не работает".into(),
            "Узел ответил отказом — машина жива, а служба остановлена или слушает другой порт.".into(),
        ));
    }
    if l.contains("no route") || l.contains("unreachable") || l.contains("недоступ") {
        return Some((Zone::General, "нет маршрута", "Нет маршрута до узла".into(), "Сеть до узла недоступна: проверьте маршрутизацию, канал или туннель на пути.".into()));
    }
    if l.contains("timed out") || l.contains("timeout") || l.contains("таймаут") {
        return Some((
            Zone::Target,
            "нет ответа за таймаут",
            format!("Ответа нет за {timeout_ms} мс"),
            "Узел выключен или перегружен, либо порт молча отбрасывается файрволом. Если ping до адреса проходит — проблема в сервисе, файрволе или MTU туннеля.".into(),
        ));
    }
    None
}

fn analyze_http(inp: &Input, down_now: bool, out: &mut Vec<Finding>) {
    let s = inp.samples;
    let last = s.last().unwrap();
    let failing_now = down_now || last.error.is_some();
    if failing_now {
        let code = last.status_code;
        let e = last.error.clone().unwrap_or_default();
        let blocked_icmp = inp.same_host.iter().any(|x| matches!(x.kind, CheckKind::Ping | CheckKind::Trace) && !x.ok);
        if let Some(c) = code.filter(|c| *c >= 400) {
            let (short, title, hint) = match c {
                500 => ("ошибка 500 — сбой приложения", "Сайт отвечает ошибкой 500", "Сеть и веб-сервер работают, падает код приложения или база данных. Смотрите логи приложения."),
                502 => ("ошибка 502 — не отвечает бэкенд", "Ошибка 502: прокси не получил ответ от приложения", "Веб-сервер или балансировщик работает, приложение за ним не отвечает."),
                503 => ("ошибка 503 — перегрузка или обслуживание", "Ошибка 503: сервис временно недоступен", "Сервер перегружен или включён режим обслуживания."),
                504 => ("ошибка 504 — таймаут бэкенда", "Ошибка 504: приложение не ответило вовремя", "Прокси ждал приложение слишком долго: медленные запросы или зависшая база."),
                401 | 403 => ("доступ запрещён (401/403)", "Доступ запрещён", "Нужна авторизация, либо адрес заблокирован: WAF, защита от ботов, гео-ограничение или файрвол сайта."),
                404 => ("страница не найдена (404)", "Страница не найдена", "Неверный адрес проверки или страницу переименовали."),
                429 => ("слишком много запросов (429)", "Слишком много запросов", "Сайт ограничивает частоту обращений с вашего адреса: увеличьте интервал проверки и проверяйте лёгкую страницу вместо главной."),
                c if c >= 500 => ("ошибка сервера", "Сервер отвечает ошибкой", "Проблема на стороне приложения, сеть до него работает."),
                _ => ("ошибка запроса", "Сайт отвечает ошибкой запроса", "Проверьте адрес, метод и ожидаемые коды в настройках проверки."),
            };
            out.push(f(Level::Crit, Zone::Target, Rule::Availability, short, title, format!("Код ответа {c}."), Some(hint.into()), None));
            if matches!(c, 401 | 403 | 429) && blocked_icmp {
                out.push(f(
                    Level::Warn,
                    Zone::Dest,
                    Rule::Availability,
                    "похоже, ваш адрес заблокирован защитой сайта",
                    "Похоже, ваш адрес заблокирован защитой сайта",
                    format!("Сайт отвечает {c}, и одновременно перестал проходить ICMP до того же адреса."),
                    Some("Так выглядит блокировка адреса защитой от ботов или DDoS. Проверьте доступность с другой сети и попросите добавить ваш адрес в белый список; заодно снизьте частоту проверок.".into()),
                    None,
                ));
            }
        } else if e.contains("в ответе нет строки") {
            out.push(f(
                Level::Crit,
                Zone::Target,
                Rule::Availability,
                "нет ожидаемого текста на странице",
                "Сайт отвечает, но ожидаемого текста на странице нет",
                e.clone(),
                Some("Изменилось содержимое страницы, либо вместо сайта отдаётся заглушка или страница ошибки.".into()),
                None,
            ));
        } else if e.contains("неожиданный код ответа") && code.map_or(false, |c| c < 400) {
            out.push(f(
                Level::Warn,
                Zone::Target,
                Rule::Availability,
                "код ответа не совпадает с ожидаемым",
                "Код ответа не совпадает с ожидаемым в настройках",
                e.clone(),
                Some("Сайт работает, но отвечает не тем кодом. Поправьте список ожидаемых кодов в настройках цели или адрес проверки.".into()),
                None,
            ));
        } else if let Some((z, short, title, hint)) = explain_conn(&e, inp.timeout_ms) {
            out.push(f(Level::Crit, z, Rule::Availability, short, title, e.clone(), Some(hint), None));
        } else if !e.is_empty() {
            out.push(f(Level::Crit, Zone::Target, Rule::Availability, "сайт недоступен", "Сайт недоступен", e.clone(), None, None));
        }
    } else {
        common_intermittent(inp, out);
        if let Some(p50) = median_ok(s) {
            // Сайт отвечает корректным кодом: медленный ответ — это замечание, а не проблема.
            if inp.th.warn_ms.is_finite() && p50 as f64 > inp.th.warn_ms && s.len() >= 10 {
                out.push(f(
                    Level::Info,
                    Zone::Target,
                    Rule::Latency,
                    "",
                    format!("Сайт отвечает дольше порога: {p50:.0} мс"),
                    format!("Код ответа в норме. Медиана времени до первого байта, порог — {:.0} мс.", inp.th.warn_ms),
                    Some("Если ping до сервера быстрый, тормозит само приложение или база. Если медленный — смотрите канал.".into()),
                    None,
                ));
            }
        }
    }
    if let Some(d) = inp.cert_days {
        if d <= inp.cert_warn_days {
            out.push(f(
                if d <= 3 { Level::Crit } else { Level::Warn },
                Zone::Target,
                Rule::Cert,
                format!("сертификат истекает через {d} дн."),
                format!("TLS-сертификат истекает через {d} дн."),
                "После истечения браузеры перестанут открывать сайт без предупреждения.".to_string(),
                Some("Продлите сертификат заранее и проверьте автопродление.".into()),
                None,
            ));
        }
    }
}

fn analyze_tcp(inp: &Input, down_now: bool, out: &mut Vec<Finding>) {
    let last = inp.samples.last().unwrap();
    if down_now || last.error.is_some() {
        let e = last.error.clone().unwrap_or_default();
        let ping_ok = inp.same_host.iter().any(|x| matches!(x.kind, CheckKind::Ping | CheckKind::Trace) && x.ok);
        match explain_conn(&e, inp.timeout_ms) {
            Some((z, short, title, hint)) => {
                let extra = if ping_ok && (e.to_lowercase().contains("таймаут") || e.to_lowercase().contains("timed out")) {
                    " До адреса при этом проходит ping: узел жив, значит порт закрыт файрволом, служба не слушает, либо мешает MTU на туннеле."
                } else {
                    ""
                };
                out.push(f(Level::Crit, z, Rule::Availability, short, title, format!("{e}{extra}"), Some(hint), None));
            }
            None => out.push(f(Level::Crit, Zone::Target, Rule::Availability, "порт недоступен", "Порт недоступен", e, None, None)),
        }
    } else {
        common_intermittent(inp, out);
    }
}

fn analyze_dns(inp: &Input, down_now: bool, out: &mut Vec<Finding>) {
    let last = inp.samples.last().unwrap();
    if down_now || last.error.is_some() {
        let e = last.error.clone().unwrap_or_default();
        let l = e.to_lowercase();
        let (short, title, hint) = if l.contains("таймаут") || l.contains("timeout") {
            ("DNS-сервер не отвечает", "DNS-сервер не отвечает", "Служба остановлена, сервер выключен или UDP/53 закрыт на пути. Если ping до сервера проходит, проблема в службе или файрволе.")
        } else if l.contains("nxdomain") {
            ("имя не найдено (NXDOMAIN)", "Сервер отвечает, что имя не существует", "Проверьте запрашиваемое имя. Если оно верное — удалена запись или сломана зона.")
        } else if l.contains("servfail") {
            ("SERVFAIL — сбой обработки запроса", "Сервер не смог получить ответ (SERVFAIL)", "Сервер работает, но не получил ответ от вышестоящих DNS или не прошла проверка DNSSEC.")
        } else if l.contains("refused") {
            ("сервер отказал (REFUSED)", "Сервер отказывается отвечать (REFUSED)", "Рекурсия запрещена для вашего адреса или запрос не разрешён политикой сервера.")
        } else if l.contains("неожиданный ответ") {
            ("ответ не совпадает с ожидаемым", "Сервер вернул не тот адрес, что ожидался", "Изменились записи зоны или ответ подменяется по пути. Сверьте ответ с авторитетным сервером и обновите ожидаемые адреса в настройках цели.")
        } else {
            ("ошибка DNS-запроса", "Ошибка DNS-запроса", "")
        };
        out.push(f(Level::Crit, Zone::Target, Rule::Availability, short, title, e, (!hint.is_empty()).then(|| hint.to_string()), None));
    } else {
        common_intermittent(inp, out);
        if let Some(p50) = median_ok(inp.samples) {
            if inp.th.warn_ms.is_finite() && p50 as f64 > inp.th.warn_ms && inp.samples.len() >= 10 {
                out.push(f(
                    Level::Warn,
                    Zone::Target,
                    Rule::Latency,
                    format!("медленные ответы DNS: {p50:.0} мс"),
                    format!("DNS отвечает медленно: {p50:.0} мс"),
                    format!("Медиана времени ответа, порог — {:.0} мс.", inp.th.warn_ms),
                    Some("Медленный DNS замедляет открытие всех ресурсов. Проверьте нагрузку на сервер и его вышестоящие DNS.".into()),
                    None,
                ));
            }
        }
    }
}

fn median_ok(s: &[Sample]) -> Option<f32> {
    let mut v: Vec<f32> = s.iter().filter_map(|x| x.rtt_ms).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(f32::total_cmp);
    Some(v[v.len() / 2])
}

/// Периодические ошибки у сервисов (HTTP, TCP, DNS).
fn common_intermittent(inp: &Input, out: &mut Vec<Finding>) {
    let s = inp.samples;
    let fails = s.iter().filter(|x| x.error.is_some()).count();
    if s.len() >= 20 && fails >= 3 && fails * 100 >= s.len() * 5 {
        if let Some((e, n)) = top_error(s) {
            let share = fails as f32 * 100.0 / s.len() as f32;
            let hint = explain_conn(&e, inp.timeout_ms).map(|x| x.3);
            out.push(f(
                Level::Warn,
                Zone::Target,
                Rule::Availability,
                format!("периодические ошибки {}", pct(share)),
                format!("Периодические ошибки: {} проверок", pct(share)),
                format!("Чаще всего ({n} раз): {e}"),
                hint,
                None,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::HopSample;

    const IV: i64 = 2500;

    fn trace(ts: i64, hops: &[(&str, Option<f32>)], dest: Option<f32>) -> Sample {
        let hs = hops
            .iter()
            .enumerate()
            .map(|(i, (a, r))| HopSample { ttl: i as u8 + 1, addr: r.is_some().then(|| a.parse().unwrap()), rtt_ms: *r })
            .collect();
        Sample { ts, rtt_ms: dest, status_code: None, error: dest.is_none().then(|| "цель не ответила".into()), hops: hs }
    }

    fn input<'a>(s: &'a [Sample], th: &'a Thresholds, names: &'a HashMap<IpAddr, String>, host: &'a str) -> Input<'a> {
        Input {
            kind: CheckKind::Trace,
            host,
            th,
            timeout_ms: 3000,
            interval_ms: IV as u64,
            down_after: 4,
            samples: s,
            hostnames: names,
            known_route: &[],
            parent_failing: None,
            monitor_wide: None,
            flaps_hour: 0,
            route_change: None,
            ip_change: None,
            peak_hours: vec![],
            others: vec![],
            same_host: vec![],
            cert_days: None,
            cert_warn_days: 14,
            resolve_error: None,
            now: s.last().map_or(0, |x| x.ts),
            clamped: false,
        }
    }

    /// Цель не отвечает, маршрут до предпоследнего хопа жив.
    #[test]
    fn target_silent_route_ok() {
        let th = Thresholds::default();
        let names = HashMap::new();
        let ok = [("10.0.0.1", Some(1.0)), ("198.51.100.1", Some(3.0)), ("198.51.100.9", Some(5.0)), ("203.0.113.5", Some(6.0))];
        let bad = [("10.0.0.1", Some(1.0)), ("198.51.100.1", Some(3.0)), ("198.51.100.9", Some(5.0)), ("x", None)];
        let mut s: Vec<Sample> = (0..60).map(|i| trace(i * IV, &ok, Some(6.0))).collect();
        s.extend((60..80).map(|i| trace(i * IV, &bad, None)));
        let d = analyze(&input(&s, &th, &names, "203.0.113.5"));
        assert_eq!(d.level, Level::Crit);
        assert!(d.cause.as_deref().unwrap().contains("узел молчит"), "{:?}", d.cause);
    }

    /// Тот же случай, но рядом живая проверка TCP — это фильтрация ICMP, а не авария.
    #[test]
    fn icmp_filtered_service_alive() {
        let th = Thresholds::default();
        let names = HashMap::new();
        let ok = [("10.0.0.1", Some(1.0)), ("198.51.100.1", Some(3.0)), ("203.0.113.5", Some(6.0))];
        let bad = [("10.0.0.1", Some(1.0)), ("198.51.100.1", Some(3.0)), ("x", None)];
        let mut s: Vec<Sample> = (0..60).map(|i| trace(i * IV, &ok, Some(6.0))).collect();
        s.extend((60..80).map(|i| trace(i * IV, &bad, None)));
        let mut inp = input(&s, &th, &names, "203.0.113.5");
        inp.same_host = vec![SameHost { name: "Порт 443".into(), kind: CheckKind::Tcp, ok: true }];
        let d = analyze(&inp);
        assert_eq!(d.level, Level::Warn);
        assert!(d.cause.as_deref().unwrap().contains("ICMP фильтруется"), "{:?}", d.cause);
    }

    /// Обрыв на транзитном участке: зона берётся по имени следующего хопа.
    #[test]
    fn break_at_transit() {
        let th = Thresholds::default();
        let mut names = HashMap::new();
        names.insert("198.51.100.1".parse().unwrap(), "gw1.isp-a.example".to_string());
        names.insert("198.51.100.9".parse().unwrap(), "core.isp-a.example".to_string());
        names.insert("192.0.2.7".parse().unwrap(), "ae1.transit-b.example".to_string());
        names.insert("192.0.2.8".parse().unwrap(), "ae2.transit-b.example".to_string());
        names.insert("203.0.113.1".parse().unwrap(), "edge.dest-c.example".to_string());
        let ok = [
            ("10.0.0.1", Some(1.0)),
            ("198.51.100.1", Some(3.0)),
            ("198.51.100.9", Some(4.0)),
            ("192.0.2.7", Some(6.0)),
            ("192.0.2.8", Some(7.0)),
            ("203.0.113.1", Some(9.0)),
            ("203.0.113.5", Some(10.0)),
        ];
        let bad = [("10.0.0.1", Some(1.0)), ("198.51.100.1", Some(3.0)), ("198.51.100.9", Some(4.0)), ("x", None), ("x", None), ("x", None), ("x", None)];
        let mut s: Vec<Sample> = (0..60).map(|i| trace(i * IV, &ok, Some(10.0))).collect();
        s.extend((60..80).map(|i| trace(i * IV, &bad, None)));
        let d = analyze(&input(&s, &th, &names, "203.0.113.5"));
        let c = d.cause.unwrap();
        assert!(c.contains("обрыв после хопа 3") && c.contains("транзит"), "{c}");
    }

    /// Потери, совпадающие по времени с потерями до цели, и рядом хоп с ограничением ICMP.
    #[test]
    fn loss_origin_vs_rate_limit() {
        let th = Thresholds { warn_loss: 2.0, ..Thresholds::default() };
        let names = HashMap::new();
        let mut s = vec![];
        for i in 0..200i64 {
            let rate_limited = i % 3 == 0; // хоп 2 отвечает не всегда, но трафик идёт
            let real = i % 10 == 0; // с хопа 3 реальные потери, доходят до цели
            s.push(trace(
                i * IV,
                &[
                    ("10.0.0.1", Some(1.0)),
                    ("198.51.100.1", if rate_limited { None } else { Some(2.0) }),
                    ("192.0.2.7", if real { None } else { Some(3.0) }),
                    ("203.0.113.5", if real { None } else { Some(4.0) }),
                ],
                if real { None } else { Some(4.0) },
            ));
        }
        let d = analyze(&input(&s, &th, &names, "203.0.113.5"));
        assert!(d.cause.as_deref().unwrap().contains("с хопа 3"), "{:?}", d.findings);
        assert!(d.findings.iter().any(|x| x.title.contains("хопе 2") && x.title.contains("не влияют")), "{:?}", d.findings);
    }

    /// Разрыв в данных: сон компьютера не должен превращаться в «узел недоступен».
    #[test]
    fn sleep_gap_is_not_outage() {
        let th = Thresholds::default();
        let names = HashMap::new();
        let ok = [("10.0.0.1", Some(1.0)), ("203.0.113.5", Some(4.0))];
        let mut s: Vec<Sample> = (0..60).map(|i| trace(i * IV, &ok, Some(4.0))).collect();
        // Две неудачные перед сном, затем дыра в 2 часа и одна неудачная после.
        s.push(trace(60 * IV, &[("10.0.0.1", Some(1.0)), ("x", None)], None));
        s.push(trace(61 * IV, &[("10.0.0.1", Some(1.0)), ("x", None)], None));
        let after = 61 * IV + 2 * 3600_000;
        s.push(trace(after, &[("10.0.0.1", Some(1.0)), ("x", None)], None));
        let mut inp = input(&s, &th, &names, "203.0.113.5");
        inp.now = after + IV;
        let d = analyze(&inp);
        assert_ne!(d.level, Level::Crit, "{:?}", d.findings);
        assert!(d.findings.iter().any(|x| x.title.contains("перерыв")), "{:?}", d.findings);
    }

    /// Устаревшие данные: цель на паузе — выводов об аварии быть не должно.
    #[test]
    fn stale_window() {
        let th = Thresholds::default();
        let names = HashMap::new();
        let s: Vec<Sample> = (0..40).map(|i| trace(i * IV, &[("10.0.0.1", Some(1.0)), ("x", None)], None)).collect();
        let mut inp = input(&s, &th, &names, "203.0.113.5");
        inp.now = 40 * IV + 3_600_000;
        let d = analyze(&inp);
        assert!(d.stale);
        assert!(d.cause.is_none(), "{:?}", d.cause);
    }

    /// Ровная прибавка задержки на дальнем хопе — это расстояние, а не перегрузка.
    #[test]
    fn stable_latency_is_distance() {
        let th = Thresholds { warn_ms: 10.0, bad_ms: 30.0, crit_ms: 60.0, ..Thresholds::default() };
        let names = HashMap::new();
        let s: Vec<Sample> = (0..120)
            .map(|i| {
                let n = (i % 3) as f32 * 0.5;
                trace(i * IV, &[("10.0.0.1", Some(1.0 + n)), ("198.51.100.1", Some(3.0 + n)), ("192.0.2.7", Some(60.0 + n)), ("203.0.113.5", Some(61.0 + n))], Some(61.0 + n))
            })
            .collect();
        let d = analyze(&input(&s, &th, &names, "203.0.113.5"));
        let lat = d.findings.iter().find(|x| x.title.contains("Задержка")).expect("нет вывода о задержке");
        assert!(lat.title.contains("стабильно прибавляет"), "{}", lat.title);
    }

    /// Один потерянный пакет у 10 проверок не должен давать вывод о потерях.
    #[test]
    fn small_sample_no_loss_claim() {
        let th = Thresholds { warn_loss: 2.0, ..Thresholds::default() };
        let names = HashMap::new();
        let mut s: Vec<Sample> = (0..9).map(|i| trace(i * IV, &[("10.0.0.1", Some(1.0)), ("203.0.113.5", Some(4.0))], Some(4.0))).collect();
        s.push(trace(9 * IV, &[("10.0.0.1", Some(1.0)), ("x", None)], None));
        let d = analyze(&input(&s, &th, &names, "203.0.113.5"));
        assert_eq!(d.level, Level::Ok, "{:?}", d.findings);
    }

    /// Блокировка адреса защитой сайта: HTTP 403 и одновременно нет ICMP.
    #[test]
    fn waf_block() {
        let th = Thresholds::http_default();
        let names = HashMap::new();
        let s: Vec<Sample> = (0..20)
            .map(|i| Sample { ts: i * 30_000, rtt_ms: None, status_code: Some(403), error: Some("неожиданный код ответа 403".into()), hops: vec![] })
            .collect();
        let mut inp = input(&s, &th, &names, "https://example.com");
        inp.kind = CheckKind::Http;
        inp.interval_ms = 30_000;
        inp.now = s.last().unwrap().ts;
        inp.same_host = vec![SameHost { name: "example.com".into(), kind: CheckKind::Trace, ok: false }];
        let d = analyze(&inp);
        assert!(d.findings.iter().any(|x| x.short.contains("заблокирован защитой сайта")), "{:?}", d.findings);
    }

    #[test]
    fn org_parsing() {
        assert_eq!(org_of("ae3-227.rt.core.transit-b.example").as_deref(), Some("transit-b.example"));
        assert_eq!(org_of("host.node.co.uk").as_deref(), Some("node.co.uk"));
        assert_eq!(org_of("host.isp.com").as_deref(), Some("isp.com"));
        assert_eq!(org_of("203.0.113.5"), None);
    }

    #[test]
    fn plural_forms() {
        assert_eq!(plural(1, "цель", "цели", "целей"), "1 цель");
        assert_eq!(plural(3, "цель", "цели", "целей"), "3 цели");
        assert_eq!(plural(11, "цель", "цели", "целей"), "11 целей");
        assert_eq!(plural(22, "цель", "цели", "целей"), "22 цели");
    }
}
