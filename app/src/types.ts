import { t } from "./i18n";
/** Группа по умолчанию: в ней видны все цели из всех групп. */
export const DEFAULT_GROUP = "Общее";

export type CheckKind = "trace" | "ping" | "http" | "tcp" | "dns";
export type Health = "ok" | "warn" | "bad" | "crit" | "down" | "dependent" | "paused" | "unknown";

export interface Thresholds {
  /** Задержка выше — жёлтый. */
  warnMs: number;
  /** Задержка выше — оранжевый. */
  badMs: number;
  /** Задержка выше — красный. */
  critMs: number;
  /** Потери выше, % — жёлтый. */
  warnLoss: number;
  /** Потери выше, % — красный. */
  badLoss: number;
  /** Jitter выше, мс — жёлтый (0 — не проверять). */
  jitterWarn: number;
  /** Jitter выше, мс — красный (0 — не проверять). */
  jitterCrit: number;
  /** MOS ниже — жёлтый (0 — не проверять). */
  mosWarn: number;
  /** MOS ниже — красный (0 — не проверять). */
  mosCrit: number;
}

const NO_VOIP = { jitterWarn: 0, jitterCrit: 0, mosWarn: 0, mosCrit: 0 };
export const DEFAULT_THRESHOLDS: Thresholds = { warnMs: 10, badMs: 30, critMs: 50, warnLoss: 5, badLoss: 10, ...NO_VOIP };
/** Для HTTP(S): время ответа сайта (до заголовков) обычно сотни миллисекунд. */
export const HTTP_THRESHOLDS: Thresholds = { warnMs: 1000, badMs: 2000, critMs: 3000, warnLoss: 5, badLoss: 10, ...NO_VOIP };
/** Рекомендуемые пороги качества связи для телефонии. */
export const VOIP_THRESHOLDS = { jitterWarn: 20, jitterCrit: 30, mosWarn: 4.0, mosCrit: 3.6 };

export interface DnsOptions {
  /** Какое имя спрашивать у DNS-сервера (если адрес цели — IP сервера). */
  query: string;
  /** Ожидаемые IP в ответе. */
  expected: string[];
}

export interface HttpOptions {
  method: string;
  expectedStatus: number[];
  keyword: string;
  followRedirects: boolean;
  verifyTls: boolean;
}

export interface Target {
  id: string;
  name: string;
  host: string;
  kind: CheckKind;
  group: string;
  intervalMs: number;
  timeoutMs: number;
  enabled: boolean;
  port: number | null;
  maxHops: number;
  packetSize: number;
  http: HttpOptions;
  dns: DnsOptions;
  thresholds: Thresholds;
  alertsEnabled: boolean;
  notes: string;
  /** Родитель: если он недоступен, уведомления этой цели не отправляются. */
  parentId: string | null;
  /** Привязанный шаблон: интервал, таймаут, пороги и уведомления берутся из него. */
  templateId: string | null;
}

export interface TargetSummary {
  id: string;
  name: string;
  host: string;
  group: string;
  kind: CheckKind;
  enabled: boolean;
  /** false — режим тишины. */
  alertsEnabled: boolean;
  health: Health;
  resolvedIp: string | null;
  lastRtt: number | null;
  avgRtt: number | null;
  minRtt: number | null;
  maxRtt: number | null;
  jitter: number | null;
  lossPct: number;
  mos: number | null;
  hopCount: number;
  statusCode: number | null;
  lastError: string | null;
  certDays: number | null;
  /** Когда сменился маршрут (приходит только в течение 30 минут после смены). */
  routeChangedAt: number | null;
  routeChange: string | null;
  spark: (number | null)[];
  samples: number;
  lastTs: number | null;
  thresholds: Thresholds;
  parentId: string | null;
  /** Имя недоступного родителя, из-за которого недоступна цель. */
  blockedBy: string | null;
  /** Причина проблемы по анализатору (коротко). */
  cause: string | null;
  /** Когда цель в последний раз сменила состояние (для «так уже 14 минут»). */
  stateSince: number;
}

export type DiagLevel = "ok" | "info" | "warn" | "crit";
export type DiagZone = "monitor" | "local" | "internal" | "isp" | "transit" | "dest" | "target" | "parent" | "general";
export interface Finding { level: DiagLevel; zone: DiagZone; short: string; title: string; detail: string; hint: string | null; ttl: number | null }
export interface Diagnosis {
  level: DiagLevel;
  summary: string;
  cause: string | null;
  findings: Finding[];
  from: number;
  to: number;
  samples: number;
  /** Доля периода, покрытая проверками (0..1). */
  coverage: number;
  /** Анализ ограничен последними часами периода. */
  clamped: boolean;
  /** Данные устарели: последняя проверка давно. */
  stale: boolean;
}

export interface HopStats {
  ttl: number;
  addr: string | null;
  hostname: string | null;
  sent: number;
  lost: number;
  lossPct: number;
  min: number | null;
  avg: number | null;
  max: number | null;
  cur: number | null;
  jitter: number | null;
  suspect: boolean;
}

export interface TraceView {
  from: number;
  to: number;
  samples: number;
  hops: HopStats[];
  finalStats: HopStats | null;
  mos: number | null;
}

export interface TimelinePoint {
  ts: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  lossPct: number;
  count: number;
}

export interface EventRecord {
  id: number;
  ts: number;
  targetId: string | null;
  targetName: string | null;
  kind: string;
  severity: "critical" | "warning" | "info" | "ok" | string;
  message: string;
}

export interface AlertRules {
  downAfterSamples: number;
  windowSamples: number;
  lossEnabled: boolean;
  latencyEnabled: boolean;
  routeChangeEnabled: boolean;
  certDays: number;
  repeatMinutes: number;
  notifyRecovery: boolean;
  /** Сообщать, только если проблема держится дольше N секунд. */
  notifyDelaySec: number;
  quietEnabled: boolean;
  quietFrom: number;
  quietTo: number;
  digestEnabled: boolean;
  digestHour: number;
}

export interface Settings {
  retentionRawHours: number;
  retentionRollupDays: number;
  defaultIntervalMs: number;
  defaultThresholds: Thresholds;
  alertRules: AlertRules;
  channels: {
    system: boolean;
    sound: boolean;
    telegram: { enabled: boolean; botToken: string; chatId: string; interactive: boolean };
    webhook: { enabled: boolean; url: string; format: "slack" | "discord" | "generic" };
    email: {
      enabled: boolean;
      host: string;
      port: number;
      security: "starttls" | "tls" | "none";
      username: string;
      password: string;
      from: string;
      to: string;
    };
  };
  minimizeToTray: boolean;
  launchAtLogin: boolean;
  autoUpdate: boolean;
  /** Язык интерфейса. */
  language: "ru" | "en";
  /** Тема оформления. */
  theme: string;
  /** Кто дежурит за этим компьютером. */
  dutyName: string;
  /** Контакт для обратной связи в заявке оператору. */
  dutyContact: string;
  /** Целевая доступность для отчётов, %. */
  slaTarget: number;
  /** Контроль и отслеживание инцидентов: взять в работу, тишина, заявки, напоминания, кнопки бота. */
  incidentControl: boolean;
  /** Вид дашборда: mosaic, rings, rows. */
  wallboardView: string;
  templates: TargetTemplate[];
}

/** Шаблон настроек цели. */
export interface TargetTemplate {
  id: string;
  name: string;
  intervalMs: number;
  timeoutMs: number;
  thresholds: Thresholds;
  alertsEnabled: boolean;
  /** Группы, новые узлы в которых получают этот шаблон автоматически. */
  groups: string[];
}

export function defaultTemplates(): TargetTemplate[] {
  const t = (id: string, name: string, intervalMs: number, th: Partial<Thresholds>): TargetTemplate =>
    ({ id, name, intervalMs, timeoutMs: 3000, alertsEnabled: true, groups: [], thresholds: { ...DEFAULT_THRESHOLDS, ...th } });
  return [
    t("l2", "L2-линк", 2500, { warnMs: 10, badMs: 20, critMs: 40, warnLoss: 1, badLoss: 5 }),
    t("isp", "Интернет-канал", 2500, { warnMs: 40, badMs: 70, critMs: 100, warnLoss: 2, badLoss: 5 }),
    t("voip", "Телефония", 2500, { warnMs: 40, badMs: 70, critMs: 100, warnLoss: 1, badLoss: 3, ...VOIP_THRESHOLDS }),
    t("site", "Сайт", 30000, { warnMs: 1000, badMs: 2000, critMs: 3000, warnLoss: 5, badLoss: 10 }),
    t("dns", "DNS-сервер", 30000, { warnMs: 50, badMs: 100, critMs: 200, warnLoss: 5, badLoss: 10 }),
  ];
}

export interface DuplicatePair { host: string; pingId: string; pingName: string; traceId: string; traceName: string; group: string }

export interface ReportRow {
  id: string; name: string; host: string; group: string; kind: CheckKind | null;
  uptimePct: number | null; checks: number; lost: number; lossPct: number;
  avgMs: number | null; maxMs: number | null; downtimeMs: number; outages: number; incidents: number;
  worstHour: number | null; worstHourLoss: number; worstHourAvg: number | null;
}

export interface HeatCell { dow: number; hour: number; avg: number | null; lossPct: number; count: number }

export interface HopSeries { ttl: number; addr: string | null; hostname: string | null; points: TimelinePoint[] }

export interface UpdateInfo { version: string; current: string; notes: string | null; date: string | null }

export interface LicenseStatus {
  licensed: boolean;
  /** Ключ со скрытой серединой. */
  key: string;
  targetLimit: number;
  targets: number;
}

export interface EngineInfo {
  icmpMode: string | null;
  icmpError: string | null;
  supportsTrace: boolean;
  version: string;
  dataDir: string;
  /** Файл журнала работы программы. */
  logPath: string;
  /** Сообщение о восстановлении после повреждённой базы. */
  dbWarning: string | null;
}

export interface AlertPayload {
  alert: { targetId: string; targetName: string; kind: string; severity: string; message: string; notify: boolean; silent?: boolean };
  sound: boolean;
  /** Событие входит в инцидент — о нём сообщает уведомление инцидента, а не отдельное. */
  viaIncident?: boolean;
}

/** Недоступность, потери, задержка и восстановления — сообщаются через инциденты. */
export const INCIDENT_KINDS = ["down", "outage", "loss", "latency", "jitter", "mos", "warning", "recovered", "loss_ok", "latency_ok", "jitter_ok", "mos_ok"];

export interface IncidentNotice {
  /** open | close | remind | demo */
  event: string;
  title: string;
  body: string;
  severity: string;
  incident: Incident;
}

export interface IncidentPayload {
  notice: IncidentNotice;
  sound: boolean;
}

/** Запись в ленте уведомлений (колокольчик). */
export interface FeedItem {
  id: string;
  ts: number;
  title: string;
  body: string;
  severity: string;
  incidentId?: string;
  targetId?: string;
  event?: string;
}

const KIND_LABEL_RU: Record<CheckKind, string> = {
  trace: "Трассировка",
  ping: "Ping",
  http: "HTTP(S)",
  tcp: "TCP-порт",
  dns: "DNS",
};

/** Подписи переводятся на лету: места использования не меняются. */
export const KIND_LABEL: Record<CheckKind, string> = new Proxy(KIND_LABEL_RU, {
  get: (o, k) => t(o[k as CheckKind] ?? String(k)),
});

const HEALTH_LABEL_RU: Record<Health, string> = {
  ok: "В норме",
  warn: "Внимание",
  bad: "Проблемы",
  crit: "Критично",
  down: "Недоступен",
  dependent: "Из-за родителя",
  paused: "Пауза",
  unknown: "Ожидание",
};

export const HEALTH_LABEL: Record<Health, string> = new Proxy(HEALTH_LABEL_RU, {
  get: (o, k) => t(o[k as Health] ?? String(k)),
});

export function defaultTarget(): Target {
  return {
    id: "",
    name: "",
    host: "",
    kind: "trace",
    group: "Общее",
    intervalMs: 2500,
    timeoutMs: 3000,
    enabled: true,
    port: null,
    maxHops: 30,
    packetSize: 56,
    http: { method: "GET", expectedStatus: [], keyword: "", followRedirects: true, verifyTls: true },
    dns: { query: "example.com", expected: [] },
    thresholds: { ...DEFAULT_THRESHOLDS },
    alertsEnabled: true,
    notes: "",
    parentId: null,
    templateId: null,
  };
}

/** Порядок статусов при сортировке «сначала проблемы». */
export const HEALTH_ORDER: Record<Health, number> = {
  down: 0,
  crit: 1,
  bad: 2,
  dependent: 3,
  warn: 4,
  unknown: 5,
  ok: 6,
  paused: 7,
};

/** Маршрут от этого компьютера до цели — основа карты сети. */
export interface MapRoute {
  targetId: string;
  /** Адреса хопов по порядку; null — хоп не ответил. Сама цель сюда не входит. */
  hops: (string | null)[];
  reached: boolean;
  at: number;
  /** Маршрут отслеживается непрерывно (цель-трассировка). */
  live: boolean;
  /** Во время аварии: сколько хопов ещё отвечают. Дальше — обрыв. */
  reach: number | null;
}

export interface MapHop {
  ip: string;
  name: string | null;
  private: boolean;
  rtt: number | null;
  loss: number | null;
}

export interface Topology {
  localIp: string | null;
  routes: MapRoute[];
  hops: MapHop[];
  pending: number;
}

/** Сканирование сети по кнопке. */
export interface ScanProgress {
  running: boolean;
  phase: string;
  done: number;
  total: number;
  started: number;
  finished: number;
  error: string | null;
  scanId: string | null;
}
export interface ScanTrace {
  targetId: string;
  ip: string;
  hops: (string | null)[];
  reached: boolean;
  alt: (string | null)[][];
}
export interface ScanService { port: number; name: string; banner: string | null }
export interface ScanDevice {
  ip: string;
  subnet: string;
  mac: string | null;
  vendor: string | null;
  name: string | null;
  rtt: number | null;
  ping: boolean;
  ports: number[];
  services: ScanService[];
  kind: string | null;
  os: string | null;
  osSource: string | null;
  targetId: string | null;
  firstSeen: number;
  lastSeen: number;
}
export interface ScanResult {
  id: string;
  started: number;
  finished: number;
  localIp: string | null;
  gateway: string | null;
  subnets: string[];
  traces: ScanTrace[];
  devices: ScanDevice[];
  names: Record<string, string>;
}
export interface ScanInfo { id: string; started: number; finished: number; traces: number; devices: number }
export interface SubnetHint { subnet: string; targets: number; local: boolean }

// ---------------------------------------------------------------- Инциденты и операторы

export interface IncidentTarget { id: string; name: string; host: string; since: number; until: number | null; problem: string }
export interface IncidentLog { ts: number; text: string }
export interface IncidentTicket { operatorId: string; operatorName: string; number: string; by: string; at: number }
export interface Incident {
  id: string;
  opened: number;
  closed: number | null;
  severity: "critical" | "warning";
  kind: "down" | "degraded";
  group: string;
  title: string;
  cause: string | null;
  targets: IncidentTarget[];
  ackBy: string | null;
  ackAt: number | null;
  mutedUntil: number | null;
  ticket: IncidentTicket | null;
  log: IncidentLog[];
  notifiedAt: number | null;
  silent: boolean;
  tgMessageId: number | null;
  remindedAt: number | null;
}

export interface Contact { value: string; label: string }
export interface OperatorService {
  id: string;
  number: string;
  address: string;
  ips: string;
  speed: string;
  note: string;
  role: "primary" | "backup";
  targets: string[];
  groups: string[];
}
/** Встроенные типы оператора; кроме них можно задать своё название («Площадка», «Офис»…). */
export type BuiltinOperatorKind = "provider" | "datacenter" | "hosting" | "cloud" | "contractor" | "other";
export type OperatorKind = string;
export interface Operator {
  id: string;
  name: string;
  kind: OperatorKind;
  phones: Contact[];
  emails: Contact[];
  portal: string;
  telegram: string;
  escalation: string;
  contract: string;
  account: string;
  slaReactMin: number;
  slaFixHours: number;
  slaUptime: number;
  domains: string;
  notes: string;
  services: OperatorService[];
}
export interface TargetOperator { operator: Operator; service: OperatorService | null; via: "target" | "group" | "hint" | "name" }
export interface TicketDraft { operatorId: string | null; operatorName: string | null; to: string | null; subject: string; body: string }
export interface DowntimeProfile { id: string; days: [number, number][]; hours: number[] }

export const OPERATOR_KIND: Record<string, string> = {
  provider: "Провайдер",
  datacenter: "ЦОД",
  hosting: "Хостинг",
  cloud: "Облако",
  contractor: "Подрядчик",
  other: "Другое",
};
/** Подпись типа оператора: встроенный — по словарю, свой — как ввели. */
export const operatorKindLabel = (k: string) => OPERATOR_KIND[k] ?? k;
export const isBuiltinKind = (k: string) => k in OPERATOR_KIND;

export function emptyOperator(): Operator {
  return {
    id: "", name: "", kind: "provider", phones: [{ value: "", label: "Техподдержка" }], emails: [{ value: "", label: "Заявки" }],
    portal: "", telegram: "", escalation: "", contract: "", account: "", slaReactMin: 0, slaFixHours: 0, slaUptime: 0,
    domains: "", notes: "", services: [],
  };
}
