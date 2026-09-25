use serde::{Deserialize, Serialize};
use std::net::IpAddr;

/// Тип проверки цели.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CheckKind {
    /// ICMP-трассировка: все промежуточные узлы до цели.
    Trace,
    /// Простой ICMP ping только до цели.
    Ping,
    /// HTTP(S)-запрос: код ответа, время, срок сертификата.
    Http,
    /// Подключение к TCP-порту.
    Tcp,
    /// Время DNS-резолва.
    Dns,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Thresholds {
    /// Задержка выше — жёлтый.
    pub warn_ms: f64,
    /// Задержка выше — оранжевый.
    pub bad_ms: f64,
    /// Задержка выше — красный.
    pub crit_ms: f64,
    /// Потери выше, % — жёлтый.
    pub warn_loss: f64,
    /// Потери выше, % — красный.
    pub bad_loss: f64,
    /// Jitter выше, мс — жёлтый (0 = не проверять).
    pub jitter_warn: f64,
    /// Jitter выше, мс — красный (0 = не проверять).
    pub jitter_crit: f64,
    /// MOS ниже — жёлтый (0 = не проверять).
    pub mos_warn: f64,
    /// MOS ниже — красный (0 = не проверять).
    pub mos_crit: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self { warn_ms: 10.0, bad_ms: 30.0, crit_ms: 50.0, warn_loss: 5.0, bad_loss: 10.0, jitter_warn: 0.0, jitter_crit: 0.0, mos_warn: 0.0, mos_crit: 0.0 }
    }
}

impl Thresholds {
    /// Рекомендуемые пороги для HTTP(S): время ответа сайта заметно больше ping.
    pub fn http_default() -> Self {
        Self { warn_ms: 1000.0, bad_ms: 2000.0, crit_ms: 3000.0, warn_loss: 5.0, bad_loss: 10.0, ..Self::default() }
    }

    /// Рекомендуемые пороги для типа проверки.
    pub fn default_for(kind: CheckKind) -> Self {
        if kind == CheckKind::Http { Self::http_default() } else { Self::default() }
    }

    /// Пороги из версий до 1.0.4 (100/250 мс) — в любых сочетаниях третьего уровня и потерь.
    pub fn is_legacy_default(&self) -> bool {
        self.warn_ms == 100.0 && self.bad_ms == 250.0
    }

    /// Приводит старые/некорректные пороги к новой схеме.
    pub fn normalized(&self) -> Thresholds {
        if self.is_legacy_default() {
            return Thresholds { warn_loss: self.warn_loss.max(5.0), bad_loss: self.bad_loss, ..Thresholds::default() };
        }
        let mut t = self.clone();
        if t.crit_ms <= t.bad_ms {
            t.crit_ms = t.bad_ms * 2.0;
        }
        t
    }

    /// Нормализация с учётом типа: HTTP-цели с «ping-овыми» или старыми порогами
    /// получают пороги для сайтов.
    pub fn normalized_for(&self, kind: CheckKind) -> Thresholds {
        if kind == CheckKind::Http {
            let ms = (self.warn_ms, self.bad_ms);
            if self.is_legacy_default() || ms == (10.0, 30.0) || ms == (300.0, 800.0) {
                return Thresholds { warn_loss: self.warn_loss, bad_loss: self.bad_loss, ..Self::http_default() };
            }
        }
        self.normalized()
    }

    /// 0 — норма, 1 — жёлтый, 2 — оранжевый, 3 — красный.
    pub fn latency_level(&self, ms: f64) -> u8 {
        if ms > self.crit_ms { 3 } else if ms > self.bad_ms { 2 } else if ms > self.warn_ms { 1 } else { 0 }
    }

    /// 0 — норма, 1 — жёлтый, 3 — красный.
    pub fn loss_level(&self, pct: f64) -> u8 {
        if pct > self.bad_loss { 3 } else if pct > self.warn_loss { 1 } else { 0 }
    }

    /// 0 — норма, 1 — жёлтый, 3 — красный. Нулевой порог — проверка выключена.
    pub fn jitter_level(&self, ms: f64) -> u8 {
        if self.jitter_crit > 0.0 && ms > self.jitter_crit {
            3
        } else if self.jitter_warn > 0.0 && ms > self.jitter_warn {
            1
        } else {
            0
        }
    }

    /// 0 — норма, 1 — жёлтый, 3 — красный. Нулевой порог — проверка выключена.
    pub fn mos_level(&self, mos: f64) -> u8 {
        if self.mos_crit > 0.0 && mos < self.mos_crit {
            3
        } else if self.mos_warn > 0.0 && mos < self.mos_warn {
            1
        } else {
            0
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HttpOptions {
    pub method: String,
    /// Ожидаемые коды ответа (пусто = любой 2xx/3xx).
    pub expected_status: Vec<u16>,
    /// Строка, которая должна присутствовать в теле ответа.
    pub keyword: String,
    pub follow_redirects: bool,
    pub verify_tls: bool,
}

impl Default for HttpOptions {
    fn default() -> Self {
        Self {
            method: "GET".into(),
            expected_status: vec![],
            keyword: String::new(),
            follow_redirects: true,
            verify_tls: true,
        }
    }
}

/// Настройки DNS-проверки.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DnsOptions {
    /// Какое имя запрашивать, если адрес цели — IP DNS-сервера.
    pub query: String,
    /// Ожидаемые IP в ответе (пусто — любой непустой ответ).
    pub expected: Vec<String>,
}

impl Default for DnsOptions {
    fn default() -> Self {
        Self { query: "example.com".into(), expected: vec![] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Target {
    pub id: String,
    pub name: String,
    /// Хост/IP; для HTTP — полный URL.
    pub host: String,
    pub kind: CheckKind,
    pub group: String,
    pub interval_ms: u64,
    pub timeout_ms: u64,
    pub enabled: bool,
    pub port: Option<u16>,
    pub max_hops: u8,
    pub packet_size: u16,
    pub http: HttpOptions,
    pub dns: DnsOptions,
    pub thresholds: Thresholds,
    pub alerts_enabled: bool,
    pub notes: String,
    /// Родительский узел: если он недоступен, уведомления этой цели не отправляются.
    pub parent_id: Option<String>,
    /// Привязанный шаблон: интервал, таймаут, пороги и уведомления берутся из него.
    pub template_id: Option<String>,
}

impl Default for Target {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            host: String::new(),
            kind: CheckKind::Trace,
            group: "Общее".into(),
            interval_ms: 2500,
            timeout_ms: 3000,
            enabled: true,
            port: None,
            max_hops: 30,
            packet_size: 56,
            http: HttpOptions::default(),
            dns: DnsOptions::default(),
            thresholds: Thresholds::default(),
            alerts_enabled: true,
            notes: String::new(),
            parent_id: None,
            template_id: None,
        }
    }
}

/// Один хоп в одном сэмпле трассировки.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HopSample {
    pub ttl: u8,
    pub addr: Option<IpAddr>,
    pub rtt_ms: Option<f32>,
}

/// Результат одного цикла проверки цели.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub ts: i64,
    /// Время ответа конечной цели; None = потеря/ошибка.
    pub rtt_ms: Option<f32>,
    pub status_code: Option<u16>,
    pub error: Option<String>,
    pub hops: Vec<HopSample>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Ok,
    Warn,
    Bad,
    /// Красный: задержка или потери выше критического порога.
    Crit,
    Down,
    /// Недоступен, потому что недоступен родительский узел.
    Dependent,
    Paused,
    Unknown,
}

// ---------------------------------------------------------------- Настройки

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertRules {
    /// Сколько подряд потерянных сэмплов = «недоступен».
    pub down_after_samples: u32,
    /// Окно (в сэмплах) для оценки потерь и задержки.
    pub window_samples: u32,
    /// Алерт по потерям (порог «красный» = thresholds.bad_loss цели).
    pub loss_enabled: bool,
    /// Алерт по задержке (порог «красный» = thresholds.crit_ms цели).
    pub latency_enabled: bool,
    pub route_change_enabled: bool,
    /// Предупреждать, если SSL-сертификат истекает через N дней.
    pub cert_days: u32,
    /// Повторять уведомление о незакрытой проблеме каждые N минут (0 = не повторять).
    pub repeat_minutes: u32,
    pub notify_recovery: bool,
}

impl Default for AlertRules {
    fn default() -> Self {
        Self {
            down_after_samples: 4,
            window_samples: 24,
            loss_enabled: true,
            latency_enabled: true,
            route_change_enabled: false,
            cert_days: 14,
            repeat_minutes: 0,
            notify_recovery: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TelegramChannel {
    pub enabled: bool,
    pub bot_token: String,
    pub chat_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum WebhookFormat {
    #[default]
    Slack,
    Discord,
    Generic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WebhookChannel {
    pub enabled: bool,
    pub url: String,
    pub format: WebhookFormat,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SmtpSecurity {
    #[default]
    Starttls,
    Tls,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EmailChannel {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub security: SmtpSecurity,
    pub username: String,
    pub password: String,
    pub from: String,
    /// Получатели через запятую.
    pub to: String,
}

impl Default for EmailChannel {
    fn default() -> Self {
        Self {
            enabled: false,
            host: String::new(),
            port: 587,
            security: SmtpSecurity::Starttls,
            username: String::new(),
            password: String::new(),
            from: String::new(),
            to: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Channels {
    /// Системные уведомления macOS/Windows.
    pub system: bool,
    pub sound: bool,
    pub telegram: TelegramChannel,
    pub webhook: WebhookChannel,
    pub email: EmailChannel,
}

impl Default for Channels {
    fn default() -> Self {
        Self {
            system: true,
            sound: true,
            telegram: Default::default(),
            webhook: Default::default(),
            email: Default::default(),
        }
    }
}

/// Шаблон настроек цели: интервал, таймаут, пороги, уведомления.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TargetTemplate {
    pub id: String,
    pub name: String,
    pub interval_ms: u64,
    pub timeout_ms: u64,
    pub thresholds: Thresholds,
    pub alerts_enabled: bool,
    /// Группы, новые узлы в которых автоматически получают этот шаблон.
    pub groups: Vec<String>,
}

impl TargetTemplate {
    /// Переносит настройки шаблона в цель. true — что-то изменилось.
    pub fn apply_to(&self, t: &mut Target) -> bool {
        let before = (t.interval_ms, t.timeout_ms, t.thresholds.clone(), t.alerts_enabled);
        t.interval_ms = self.interval_ms;
        t.timeout_ms = self.timeout_ms;
        t.thresholds = self.thresholds.clone();
        t.alerts_enabled = self.alerts_enabled;
        before != (t.interval_ms, t.timeout_ms, t.thresholds.clone(), t.alerts_enabled)
    }
}

impl Default for TargetTemplate {
    fn default() -> Self {
        Self { id: String::new(), name: String::new(), interval_ms: 2500, timeout_ms: 3000, thresholds: Thresholds::default(), alerts_enabled: true, groups: vec![] }
    }
}

/// Шаблоны, которые есть в программе с первого запуска (их можно менять и удалять).
pub fn default_templates() -> Vec<TargetTemplate> {
    let t = |id: &str, name: &str, interval_ms: u64, th: Thresholds| TargetTemplate {
        id: id.into(),
        name: name.into(),
        interval_ms,
        timeout_ms: 3000,
        thresholds: th,
        alerts_enabled: true,
        groups: vec![],
    };
    vec![
        t("l2", "L2-линк", 2500, Thresholds { warn_ms: 10.0, bad_ms: 20.0, crit_ms: 40.0, warn_loss: 1.0, bad_loss: 5.0, ..Thresholds::default() }),
        t("isp", "Интернет-канал", 2500, Thresholds { warn_ms: 40.0, bad_ms: 70.0, crit_ms: 100.0, warn_loss: 2.0, bad_loss: 5.0, ..Thresholds::default() }),
        t("voip", "Телефония", 2500, Thresholds {
            warn_ms: 40.0, bad_ms: 70.0, crit_ms: 100.0, warn_loss: 1.0, bad_loss: 3.0,
            jitter_warn: 20.0, jitter_crit: 30.0, mos_warn: 4.0, mos_crit: 3.6,
        }),
        t("site", "Сайт", 30_000, Thresholds { warn_ms: 1000.0, bad_ms: 2000.0, crit_ms: 3000.0, warn_loss: 5.0, bad_loss: 10.0, ..Thresholds::default() }),
        t("dns", "DNS-сервер", 30_000, Thresholds { warn_ms: 50.0, bad_ms: 100.0, crit_ms: 200.0, warn_loss: 5.0, bad_loss: 10.0, ..Thresholds::default() }),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub retention_raw_hours: u32,
    pub retention_rollup_days: u32,
    pub default_interval_ms: u64,
    pub default_thresholds: Thresholds,
    pub alert_rules: AlertRules,
    pub channels: Channels,
    pub minimize_to_tray: bool,
    pub launch_at_login: bool,
    /// Проверять обновления автоматически.
    pub auto_update: bool,
    /// Язык интерфейса: "ru" или "en".
    pub language: String,
    /// Шаблоны настроек целей.
    pub templates: Vec<TargetTemplate>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            retention_raw_hours: 72,
            retention_rollup_days: 180,
            default_interval_ms: 2500,
            default_thresholds: Thresholds::default(),
            alert_rules: AlertRules::default(),
            channels: Channels::default(),
            minimize_to_tray: true,
            launch_at_login: false,
            auto_update: true,
            language: "ru".into(),
            templates: default_templates(),
        }
    }
}

// ---------------------------------------------------------------- Представления для UI

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSummary {
    pub id: String,
    pub name: String,
    pub host: String,
    pub group: String,
    pub kind: CheckKind,
    pub enabled: bool,
    /// false — режим тишины (события пишутся, уведомлений нет).
    pub alerts_enabled: bool,
    pub health: Health,
    pub resolved_ip: Option<String>,
    pub last_rtt: Option<f32>,
    pub avg_rtt: Option<f32>,
    pub min_rtt: Option<f32>,
    pub max_rtt: Option<f32>,
    pub jitter: Option<f32>,
    pub loss_pct: f32,
    pub mos: Option<f32>,
    pub hop_count: usize,
    pub status_code: Option<u16>,
    pub last_error: Option<String>,
    pub cert_days: Option<i64>,
    /// Когда сменился маршрут (показывается 30 минут).
    pub route_changed_at: Option<i64>,
    /// Что изменилось: «хоп 4: 1.1.1.1 → 2.2.2.2».
    pub route_change: Option<String>,
    /// Последние N значений задержки (None = потеря) для спарклайна.
    pub spark: Vec<Option<f32>>,
    pub samples: usize,
    pub last_ts: Option<i64>,
    pub thresholds: Thresholds,
    pub parent_id: Option<String>,
    /// Имя недоступного родителя, из-за которого недоступна цель.
    pub blocked_by: Option<String>,
    /// Причина проблемы по анализатору (коротко).
    pub cause: Option<String>,
    /// Когда цель в последний раз сменила состояние — для «так уже 14 минут».
    /// Отсчитывается с запуска программы: до него история состояний не хранится.
    pub state_since: i64,
}

/// Маршрут от этого компьютера до цели — основа карты сети.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapRoute {
    pub target_id: String,
    /// Адреса хопов по порядку TTL; None — хоп не ответил.
    pub hops: Vec<Option<String>>,
    /// Дошла ли трассировка до самой цели (сервисы за файрволом часто не отвечают на ICMP).
    pub reached: bool,
    /// Когда маршрут определён (мс). У целей-трассировок — последний раунд.
    pub at: i64,
    /// Маршрут отслеживается непрерывно (цель-трассировка), а не фоновой проверкой.
    pub live: bool,
    /// Во время аварии: сколько хопов маршрута ещё отвечают. Всё дальше — обрыв.
    pub reach: Option<usize>,
}

/// Промежуточный узел маршрута.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapHop {
    pub ip: String,
    /// Имя из обратной зоны DNS, если есть.
    pub name: Option<String>,
    /// Частный адрес — оборудование своей сети, а не провайдера или интернета.
    pub private: bool,
    pub rtt: Option<f32>,
    /// Потери на хопе, % — только там, где маршрут отслеживается непрерывно.
    pub loss: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Topology {
    /// Адрес этого компьютера в сторону сети.
    pub local_ip: Option<String>,
    pub routes: Vec<MapRoute>,
    pub hops: Vec<MapHop>,
    /// Сколько целей ещё ждут определения маршрута.
    pub pending: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HopStats {
    pub ttl: u8,
    pub addr: Option<String>,
    pub hostname: Option<String>,
    pub sent: u32,
    pub lost: u32,
    pub loss_pct: f32,
    pub min: Option<f32>,
    pub avg: Option<f32>,
    pub max: Option<f32>,
    pub cur: Option<f32>,
    pub jitter: Option<f32>,
    /// Этот хоп — первый, с которого потери идут до самой цели.
    pub suspect: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceView {
    pub from: i64,
    pub to: i64,
    pub samples: usize,
    pub hops: Vec<HopStats>,
    pub final_stats: Option<HopStats>,
    pub mos: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePoint {
    pub ts: i64,
    pub avg: Option<f32>,
    pub min: Option<f32>,
    pub max: Option<f32>,
    pub loss_pct: f32,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub id: i64,
    pub ts: i64,
    pub target_id: Option<String>,
    pub target_name: Option<String>,
    pub kind: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBundle {
    pub app: String,
    pub version: u32,
    pub targets: Vec<Target>,
    #[serde(default)]
    pub groups: Vec<String>,
    pub settings: Option<Settings>,
}

/// Пара дублей: ping и трассировка до одного адреса.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatePair {
    pub host: String,
    pub ping_id: String,
    pub ping_name: String,
    pub trace_id: String,
    pub trace_name: String,
    pub group: String,
}

/// Строка отчёта SLA за период.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReportRow {
    pub id: String,
    pub name: String,
    pub host: String,
    pub group: String,
    pub kind: Option<CheckKind>,
    pub uptime_pct: Option<f32>,
    pub checks: i64,
    pub lost: i64,
    pub loss_pct: f32,
    pub avg_ms: Option<f32>,
    pub max_ms: Option<f32>,
    /// Суммарное время полной недоступности (по минутным агрегатам).
    pub downtime_ms: i64,
    /// Число периодов полной недоступности.
    pub outages: u32,
    /// Событий «недоступен» / «был недоступен» за период.
    pub incidents: i64,
    /// Час суток с наибольшими потерями (или задержкой), локальное время.
    pub worst_hour: Option<u8>,
    pub worst_hour_loss: f32,
    pub worst_hour_avg: Option<f32>,
}

/// Ячейка тепловой карты: день недели (0 = понедельник) × час.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatCell {
    pub dow: u8,
    pub hour: u8,
    pub avg: Option<f32>,
    pub loss_pct: f32,
    pub count: i64,
}

/// Задержка одного хопа во времени.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HopSeries {
    pub ttl: u8,
    pub addr: Option<String>,
    pub hostname: Option<String>,
    pub points: Vec<TimelinePoint>,
}
