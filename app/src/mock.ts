/**
 * Демо-бэкенд для запуска интерфейса в обычном браузере (`npm run dev`) без Tauri.
 * Генерирует детерминированные синтетические данные, повторяя API Rust-ядра.
 */
import type { Diagnosis, Finding,
  AlertPayload,
  EventRecord,
  Health,
  HopStats,
  Settings,
  Target,
  TargetSummary,
  TimelinePoint,
  TraceView,
} from "./types";
import { defaultTarget, defaultTemplates } from "./types";

function rnd(a: number, b: number) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}

interface Profile {
  base: number;
  hops: number;
  noisyHop: number;
  incident: boolean;
  down: boolean;
}

const seedTargets: Array<Partial<Target> & { p: Profile }> = [
  { name: "Корпоративный портал", host: "portal.example.com", kind: "http", group: "Сервисы", intervalMs: 30000, p: { base: 85, hops: 0, noisyHop: 0, incident: false, down: false } },
  { name: "Бизнес-приложение", host: "https://app.example.com/health", kind: "http", group: "Сервисы", intervalMs: 30000, p: { base: 140, hops: 0, noisyHop: 0, incident: true, down: false } },
  { name: "Почтовый сервер (SMTP)", host: "mail.example.com", kind: "tcp", port: 587, group: "Сервисы", intervalMs: 10000, p: { base: 22, hops: 0, noisyHop: 0, incident: false, down: false } },
  { name: "Шлюз офиса", host: "192.168.1.1", kind: "ping", group: "Площадка 1", intervalMs: 2500, p: { base: 0.8, hops: 0, noisyHop: 0, incident: false, down: false } },
  { name: "Канал провайдера", host: "198.51.100.1", kind: "trace", group: "Площадка 1", p: { base: 6, hops: 5, noisyHop: 3, incident: false, down: false } },
  { name: "Публичный DNS 1", host: "198.51.100.53", kind: "trace", group: "Интернет", p: { base: 18, hops: 9, noisyHop: 4, incident: false, down: false } },
  { name: "Публичный DNS 2", host: "203.0.113.53", kind: "trace", group: "Интернет", p: { base: 14, hops: 8, noisyHop: 0, incident: false, down: false } },
  { name: "Дата-центр 1", host: "dc1.example.net", kind: "trace", group: "Дата-центры", p: { base: 48, hops: 12, noisyHop: 6, incident: true, down: false } },
  { name: "Дата-центр 2", host: "dc2.example.net", kind: "trace", group: "Дата-центры", p: { base: 62, hops: 13, noisyHop: 0, incident: false, down: false } },
  { name: "Резервный туннель", host: "tunnel.example.net", kind: "ping", group: "Дата-центры", parentId: "demo-12", p: { base: 30, hops: 0, noisyHop: 0, incident: false, down: true } },
  { name: "Проверка зоны DNS", host: "example.com", kind: "dns", group: "Интернет", intervalMs: 10000, p: { base: 12, hops: 0, noisyHop: 0, incident: false, down: false } },
  { name: "Сервер приложений", host: "app.office.local", kind: "trace", group: "Площадка 1", p: { base: 2.5, hops: 3, noisyHop: 0, incident: false, down: false } },
  { name: "VPN-концентратор", host: "10.0.0.254", kind: "ping", group: "Дата-центры", p: { base: 30, hops: 0, noisyHop: 0, incident: false, down: true } },
  { name: "Канал провайдера (ping)", host: "198.51.100.1", kind: "ping", group: "Площадка 1", p: { base: 6, hops: 0, noisyHop: 0, incident: false, down: false } },
  { name: "IP-телефония", host: "203.0.113.20", kind: "trace", group: "Сервисы", p: { base: 24, hops: 6, noisyHop: 0, incident: true, down: false } },
];

const profiles = new Map<string, Profile>();
let groups: string[] = ["Общее", "Сервисы", "Площадка 1", "Интернет", "Дата-центры"];
function applyTpl(t: Target) {
  if (!t.templateId) return;
  const tp = settings.templates.find((x) => x.id === t.templateId);
  if (!tp) { t.templateId = null; return; }
  Object.assign(t, { intervalMs: tp.intervalMs, timeoutMs: tp.timeoutMs, thresholds: { ...tp.thresholds }, alertsEnabled: tp.alertsEnabled });
}

let targets: Target[] = seedTargets.map((s, i) => {
  const t: Target = { ...defaultTarget(), ...s, id: `demo-${i}` } as Target;
  delete (t as unknown as { p?: Profile }).p;
  if (t.kind === "http") t.thresholds = { ...t.thresholds, warnMs: 1000, badMs: 2000, critMs: 3000 };
  if (t.name.includes("телефония")) t.thresholds = { ...t.thresholds, warnMs: 40, badMs: 70, critMs: 100, jitterWarn: 20, jitterCrit: 30, mosWarn: 4, mosCrit: 3.6 };
  profiles.set(t.id, s.p);
  return t;
});

let settings: Settings = {
  retentionRawHours: 72,
  retentionRollupDays: 180,
  defaultIntervalMs: 2500,
  defaultThresholds: { warnMs: 10, badMs: 30, critMs: 50, warnLoss: 5, badLoss: 10, jitterWarn: 0, jitterCrit: 0, mosWarn: 0, mosCrit: 0 },
  alertRules: {
    downAfterSamples: 4,
    windowSamples: 24,
    lossEnabled: true,
    latencyEnabled: true,
    routeChangeEnabled: false,
    certDays: 14,
    repeatMinutes: 0,
    notifyRecovery: true,
  },
  channels: {
    system: true,
    sound: true,
    telegram: { enabled: false, botToken: "", chatId: "" },
    webhook: { enabled: false, url: "", format: "slack" },
    email: { enabled: false, host: "", port: 587, security: "starttls", username: "", password: "", from: "", to: "" },
  },
  minimizeToTray: true,
  launchAtLogin: false,
  autoUpdate: true,
  language: "ru",
  templates: defaultTemplates(),
};

const now0 = Date.now();
let events: EventRecord[] = [
  { id: 5, ts: now0 - 4 * 60e3, targetId: "demo-9", targetName: "Резервный туннель", kind: "down", severity: "critical", message: "🔴 Резервный туннель (tunnel.example.net) недоступен: таймаут" },
  { id: 4, ts: now0 - 38 * 60e3, targetId: "demo-7", targetName: "Дата-центр 1", kind: "loss_ok", severity: "ok", message: "🟢 Дата-центр 1: потери в норме (0%)" },
  { id: 3, ts: now0 - 52 * 60e3, targetId: "demo-7", targetName: "Дата-центр 1", kind: "loss", severity: "warning", message: "🟠 Дата-центр 1: потери пакетов 21%" },
  { id: 2, ts: now0 - 3 * 3600e3, targetId: "demo-1", targetName: "Бизнес-приложение", kind: "latency", severity: "warning", message: "🟠 Бизнес-приложение: высокая задержка 1240 мс" },
  { id: 1, ts: now0 - 5 * 3600e3, targetId: "demo-4", targetName: "Канал провайдера", kind: "route", severity: "route", message: "🔀 Канал провайдера: сменился маршрут до узла — хоп 3: 198.51.100.9 → 198.51.100.17; хопов 5 → 6" },
  { id: 6, ts: now0 - 7 * 60e3, targetId: "demo-5", targetName: "Публичный DNS 1", kind: "route", severity: "route", message: "🔀 Публичный DNS 1: сменился маршрут до узла — хоп 4: 192.0.2.7 → 192.0.2.11; хоп 6: 192.0.2.21 → 192.0.2.25" },
];

interface Smp {
  ts: number;
  rtt: number | null;
  hops: { ttl: number; addr: string; rtt: number | null }[];
  code: number | null;
}

function sampleAt(t: Target, step: number): Smp {
  const p = profiles.get(t.id) ?? { base: 20, hops: 8, noisyHop: 0, incident: false, down: false };
  const idx = parseInt(t.id.replace(/\D/g, "")) || 7;
  const ts = step * t.intervalMs;
  const r = (k: number) => rnd(idx * 131 + k, step);
  const cyc = Math.floor(ts / 60000) % 180; // 3-часовой цикл
  const inIncident = p.incident && cyc >= 120 && cyc < 135;
  const minutesAgo = (Date.now() - ts) / 60000;
  const isDown = p.down && minutesAgo < 8;
  const wave = Math.sin(ts / 900000 + idx) * 0.15 + 1;
  let rtt: number | null = p.base * wave * (0.85 + r(1) * 0.3) + (r(2) > 0.97 ? p.base * r(3) * 2 : 0);
  if (inIncident) rtt *= 2.4;
  const lossP = isDown ? 1 : inIncident ? 0.22 : 0.004;
  if (r(4) < lossP) rtt = null;
  const hops: Smp["hops"] = [];
  if (t.kind === "trace") {
    const n = p.hops;
    for (let k = 1; k <= n; k++) {
      const frac = k / n;
      let hr: number | null = k === n ? rtt : p.base * wave * frac * (0.8 + r(10 + k) * 0.4) + 0.4;
      if (k < n && inIncident && k >= n - 3) hr = hr! * 2.2;
      if (k < n && ((k === p.noisyHop && r(30 + k) < 0.35) || (inIncident && k >= n - 3 && r(50 + k) < 0.22))) hr = null;
      if (k < n && r(70 + k) < 0.003) hr = null;
      hops.push({ ttl: k, addr: k === 1 ? "192.168.1.1" : `${10 + idx}.${k * 7}.${(k * 13) % 250}.${k + 1}`, rtt: hr });
    }
  }
  return { ts, rtt, hops, code: t.kind === "http" ? (rtt == null ? null : 200) : null };
}

function collect(t: Target, from: number, to: number, maxN = 6000): Smp[] {
  const s0 = Math.ceil(from / t.intervalMs);
  const s1 = Math.floor(Math.min(to, Date.now()) / t.intervalMs);
  const total = Math.max(0, s1 - s0 + 1);
  const stride = Math.max(1, Math.ceil(total / maxN));
  const out: Smp[] = [];
  for (let s = s0; s <= s1; s += stride) out.push(sampleAt(t, s));
  return out;
}

class Acc {
  sent = 0; lost = 0; sum = 0; min: number | null = null; max: number | null = null; cur: number | null = null;
  prev: number | null = null; js = 0; jn = 0;
  push(v: number | null) {
    this.sent++; this.cur = v;
    if (v == null) { this.lost++; return; }
    this.sum += v;
    this.min = this.min == null ? v : Math.min(this.min, v);
    this.max = this.max == null ? v : Math.max(this.max, v);
    if (this.prev != null) { this.js += Math.abs(v - this.prev); this.jn++; }
    this.prev = v;
  }
  get avg() { return this.sent > this.lost ? this.sum / (this.sent - this.lost) : null; }
  get loss() { return this.sent ? (this.lost * 100) / this.sent : 0; }
  get jitter() { return this.jn ? this.js / this.jn : null; }
}

function mos(avg: number, jit: number, loss: number) {
  const eff = avg + jit * 2 + 10;
  let r = eff < 160 ? 93.2 - eff / 40 : 93.2 - (eff - 120) / 10;
  r = Math.min(100, Math.max(0, r - loss * 2.5));
  return Math.min(4.5, Math.max(1, 1 + 0.035 * r + 0.000007 * r * (r - 60) * (100 - r)));
}

function summary(t: Target): TargetSummary {
  const now = Date.now();
  const win = collect(t, now - Math.max(10 * 60e3, t.intervalMs * 10), now);
  const acc = new Acc();
  win.forEach((s) => acc.push(s.rtt));
  const spark = collect(t, now - t.intervalMs * 60, now).map((s) => s.rtt);
  const last = win[win.length - 1];
  const th = t.thresholds;
  const recentLost = win.length >= 4 && win.slice(-4).every((s) => s.rtt == null);
  const avg = acc.avg;
  let health: Health = "ok";
  if (!t.enabled) health = "paused";
  else if (!win.length) health = "unknown";
  else if (recentLost) health = "down";
  else {
    const lvl = Math.max(acc.loss > th.badLoss ? 3 : acc.loss > th.warnLoss ? 1 : 0, avg == null ? 0 : avg > th.critMs ? 3 : avg > th.badMs ? 2 : avg > th.warnMs ? 1 : 0);
    health = (["ok", "warn", "bad", "crit"] as const)[lvl];
  }
  return {
    id: t.id, name: t.name, host: t.host, group: t.group, kind: t.kind, enabled: t.enabled, alertsEnabled: t.alertsEnabled, health,
    resolvedIp: t.kind === "http" ? null : `203.0.113.${(parseInt(t.id.replace(/\D/g, "")) || 0) + 10}`,
    lastRtt: last?.rtt ?? null, avgRtt: avg, minRtt: acc.min, maxRtt: acc.max, jitter: acc.jitter,
    lossPct: acc.loss, mos: avg == null ? null : mos(avg, acc.jitter ?? 0, acc.loss), hopCount: last?.hops.length ?? 0,
    statusCode: last?.code ?? null, lastError: last?.rtt == null ? "таймаут" : null,
    certDays: t.kind === "http" ? (t.id === "demo-1" ? 9 : 64) : null,
    routeChangedAt: t.id === "demo-5" ? now0 - 7 * 60e3 : null,
    routeChange: t.id === "demo-5" ? "хоп 4: 198.51.100.41 → 198.51.100.42; хоп 6: 203.0.113.61 → 203.0.113.62" : null,
    spark: t.enabled ? spark : [], samples: 3600, lastTs: t.enabled ? last?.ts ?? null : null, thresholds: th,
    parentId: t.parentId, blockedBy: null,
    stateSince: now0 - (t.id === "demo-1" ? 14 * 60e3 : 3 * 3600e3),
    cause: health === "down" ? (t.kind === "http" ? "нет ответа за таймаут" : "сеть в порядке, не отвечает сам узел") : health === "ok" || health === "paused" ? null : acc.loss > th.warnLoss ? `потери ${acc.loss.toFixed(0)}% с хопа 5 — транзитный оператор (transit-b.example)` : "задержка растёт с хопа 6 — транзитный оператор (transit-b.example)",
  };
}

function diagnosis(t: Target, from: number, to: number): Diagnosis {
  const s = summary(t);
  const isTrace = t.kind === "trace";
  const tr = isTrace ? trace(t, Math.max(from, to - 3 * 3600e3), to) : null;
  const findings: Finding[] = [];
  if (s.health === "down") {
    if (isTrace && tr && tr.hops.length > 1) {
      const last = tr.hops[tr.hops.length - 2];
      findings.push({
        level: "crit", zone: "target", short: s.cause ?? "",
        title: "Сеть доходит до последнего маршрутизатора перед целью, узел не отвечает",
        detail: `ICMP доходит до хопа ${last.ttl} (${last.addr ?? "*"}) — сеть на стороне цели. До этого узел отвечал нормально.`,
        hint: "Узел выключен, завис, сменил адрес или ICMP закрыт файрволом. Добавьте к этому же адресу проверку TCP-порта сервиса — она отличит выключенный узел от закрытого ICMP.",
        ttl: tr.hops.length,
      });
    } else {
      findings.push({
        level: "crit", zone: "general", short: s.cause ?? "",
        title: "Узел не отвечает",
        detail: "Подряд без ответа: 8 проверок.",
        hint: "Без трассировки нельзя отличить выключенный узел от недоступной сети — добавьте к этому адресу проверку типа «трассировка».",
        ttl: null,
      });
    }
  } else if (s.cause) {
    findings.push({
      level: "warn", zone: isTrace ? "transit" : "target", short: s.cause,
      title: s.lossPct > t.thresholds.warnLoss ? `Потери ${s.lossPct.toFixed(0)}% начинаются на хопе 5` : "Задержка растёт на хопе 6 и нестабильна",
      detail: isTrace ? "С хопа 5 (ae12.transit-b.example) потери совпадают по времени с потерями до цели. Зона: транзитный оператор (transit-b.example)." : "Проверка отвечает медленнее порога цели.",
      hint: isTrace ? "Участок транзитного оператора. Обычно решает он сам, ваш провайдер может увести трафик другим маршрутом — сообщите ему." : "Проверьте нагрузку на сервис и канал до него.",
      ttl: isTrace ? 5 : null,
    });
  } else {
    findings.push({ level: "ok", zone: "general", short: "", title: "Проблем не найдено", detail: "Узел отвечает стабильно, проверок в окне: 240.", hint: null, ttl: null });
  }
  if (isTrace) {
    findings.push({
      level: "info", zone: "general", short: "",
      title: "Всплески до 700 мс на хопе 2 — не влияют на цель",
      detail: "Медиана этого хопа 4 мс, у цели 24 мс — отдельные ответы задерживаются, сквозная задержка ровная.",
      hint: "Маршрутизатор отвечает на ICMP с низким приоритетом, когда занят. На транзитный трафик это не влияет.",
      ttl: 2,
    });
  }
  const order = { crit: 3, warn: 2, info: 1, ok: 0 } as const;
  findings.sort((a, b) => order[b.level] - order[a.level]);
  const level = findings[0].level === "info" ? "ok" : findings[0].level;
  const f0 = Math.max(from, to - 3 * 3600e3);
  return { level, summary: findings[0].title, cause: s.cause, findings, from: f0, to, samples: tr?.samples ?? 240, coverage: 1, clamped: f0 > from + 1000, stale: false };
}

function trace(t: Target, from: number, to: number): TraceView {
  const smp = collect(t, from, to);
  const map = new Map<number, Acc & { addr?: string }>();
  const fin = new Acc();
  for (const s of smp) {
    fin.push(s.rtt);
    for (const h of s.hops) {
      if (!map.has(h.ttl)) map.set(h.ttl, new Acc());
      const a = map.get(h.ttl)! as Acc & { addr?: string };
      a.push(h.rtt);
      a.addr = h.addr;
    }
  }
  const names = ["gw.office.local", "bras-1.isp-a.example", "core-2.isp-a.example", "", "ae12.transit-b.example", "ix.transit-b.example", "be3.backbone-c.example", "", "edge-1.dest-d.example"];
  const hops: HopStats[] = [...map.entries()].map(([ttl, a]) => ({
    ttl, addr: a.addr ?? null, hostname: ttl === map.size ? t.host : names[(ttl - 1) % names.length] || null,
    sent: a.sent, lost: a.lost, lossPct: a.loss, min: a.min, avg: a.avg, max: a.max, cur: a.cur, jitter: a.jitter, suspect: false,
  }));
  if (fin.loss >= 1) {
    const bar = fin.loss * 0.6;
    const i = hops.findIndex((h, i) => h.lossPct >= bar && hops.slice(i).every((x) => x.lossPct >= bar));
    if (i >= 0) hops[i].suspect = true;
  }
  const f: HopStats = { ttl: 0, addr: null, hostname: null, sent: fin.sent, lost: fin.lost, lossPct: fin.loss, min: fin.min, avg: fin.avg, max: fin.max, cur: fin.cur, jitter: fin.jitter, suspect: false };
  return { from, to, samples: smp.length, hops, finalStats: fin.sent ? f : null, mos: fin.avg == null ? null : mos(fin.avg, fin.jitter ?? 0, fin.loss) };
}

function timeline(t: Target, ttl: number | null, from: number, to: number, points: number): TimelinePoint[] {
  const smp = collect(t, from, to, points * 4);
  const step = Math.max(1, (to - from) / points);
  const buckets = new Map<number, Acc>();
  for (const s of smp) {
    const v = ttl == null ? s.rtt : s.hops.find((h) => h.ttl === ttl)?.rtt;
    if (v === undefined) continue;
    const b = Math.floor((s.ts - from) / step);
    if (!buckets.has(b)) buckets.set(b, new Acc());
    buckets.get(b)!.push(v);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, a]) => ({
    ts: from + b * step, avg: a.avg, min: a.min, max: a.max, lossPct: a.loss, count: a.sent,
  }));
}

const listeners: Array<(p: AlertPayload) => void> = [];

export const mock = {
  onAlert(cb: (p: AlertPayload) => void) {
    listeners.push(cb);
    return () => listeners.splice(listeners.indexOf(cb), 1);
  },
  async invoke(cmd: string, a: Record<string, any> = {}): Promise<unknown> {
    const find = (id: string) => {
      const t = targets.find((x) => x.id === id);
      if (!t) throw "цель не найдена";
      return t;
    };
    switch (cmd) {
      case "engine_info":
        return { icmpMode: "демо-режим (браузер)", icmpError: null, supportsTrace: true, version: "1.0.19", dataDir: "—", logPath: "—", dbWarning: null };
      case "list_targets": return structuredClone(targets);
      case "list_groups": {
        for (const t of targets) if (!groups.includes(t.group)) groups.push(t.group);
        return [...groups];
      }
      case "add_group": {
        const n = String(a.name).trim();
        if (!n) throw "введите название группы";
        if (groups.some((g) => g.toLowerCase() === n.toLowerCase())) throw `группа «${n}» уже есть`;
        groups.push(n);
        return n;
      }
      case "rename_group": {
        const n = String(a.new).trim();
        if (!n) throw "введите название группы";
        if (groups.includes(n) && n !== a.old) groups = groups.filter((g) => g !== a.old);
        else groups = groups.map((g) => (g === a.old ? n : g));
        targets.forEach((t) => { if (t.group === a.old) t.group = n; });
        return n;
      }
      case "delete_group": {
        if (a.name === "Общее") throw "«Общее» — группа по умолчанию, её нельзя удалить";
        if (a.moveTo) {
          if (!groups.includes(a.moveTo)) groups.push(a.moveTo);
          targets.forEach((t) => { if (t.group === a.name) t.group = a.moveTo; });
        } else targets = targets.filter((t) => t.group !== a.name);
        if (a.name === "Общее") throw "группу по умолчанию нельзя удалить";
        groups = groups.filter((g) => g !== a.name);
        return null;
      }
      case "reorder_groups": groups = [...a.names]; return null;
      case "move_to_group": {
        if (!groups.includes(a.group)) groups.push(a.group);
        targets.forEach((t) => {
          if (!a.ids.includes(t.id)) return;
          t.group = a.group;
          const tp = settings.templates.find((x) => x.groups.includes(a.group));
          if (!t.templateId && tp) t.templateId = tp.id;
          applyTpl(t);
        });
        return a.ids.length;
      }
      case "save_target": {
        const t: Target = structuredClone(a.target);
        if (!t.host.trim()) throw "укажите адрес";
        if (!t.name.trim()) t.name = t.host;
        applyTpl(t);
        if (!t.id) {
          t.id = `demo-${Date.now()}-${Math.round(Math.random() * 1e4)}`;
          profiles.set(t.id, { base: 10 + Math.random() * 60, hops: t.kind === "trace" ? 6 + Math.round(Math.random() * 8) : 0, noisyHop: 3, incident: false, down: false });
          targets.push(t);
        } else targets = targets.map((x) => (x.id === t.id ? t : x));
        return t;
      }
      case "save_targets": {
        for (const t of a.targets) await mock.invoke("save_target", { target: t });
        return a.targets.length;
      }
      case "delete_target": targets = targets.filter((t) => t.id !== a.id); return null;
      case "set_target_enabled": find(a.id).enabled = a.enabled; return null;
      case "reorder_targets": targets = a.ids.map((id: string) => find(id)); return null;
      case "get_summaries": {
        const list = targets.map(summary);
        for (const s of list) {
          const p = list.find((x) => x.id === s.parentId);
          if (s.health === "down" && p && (p.health === "down" || p.health === "dependent")) { s.health = "dependent"; s.blockedBy = p.name; }
        }
        return list;
      }
      case "find_duplicates": {
        const out = [];
        for (const p of targets.filter((t) => t.kind === "ping")) {
          const tr = targets.find((t) => t.kind === "trace" && t.host === p.host);
          if (tr) out.push({ host: p.host, pingId: p.id, pingName: p.name, traceId: tr.id, traceName: tr.name, group: tr.group });
        }
        return out;
      }
      case "merge_duplicates": {
        const ids = new Set(a.pairs.map((p: { pingId: string }) => p.pingId));
        targets = targets.filter((t) => !ids.has(t.id));
        return ids.size;
      }
      case "get_report": {
        return targets.map((t) => {
          const k = parseInt(t.id.replace(/\D/g, "")) || 1;
          const pr = profiles.get(t.id)!;
          const checks = Math.round((a.to - a.from) / t.intervalMs);
          const lossPct = pr.down ? 34 : pr.incident ? 1.8 : rnd(k, 7) * 0.4;
          return {
            id: t.id, name: t.name, host: t.host, group: t.group, kind: t.kind,
            uptimePct: 100 - lossPct, checks, lost: Math.round(checks * lossPct / 100), lossPct,
            avgMs: pr.base * (1 + rnd(k, 3) * 0.2), maxMs: pr.base * 4, downtimeMs: pr.down ? 3 * 3600e3 : pr.incident ? 12 * 60e3 : 0,
            outages: pr.down ? 5 : pr.incident ? 2 : 0, incidents: pr.down ? 7 : pr.incident ? 3 : 0,
            worstHour: 19 + (k % 4), worstHourLoss: Math.min(100, lossPct * 2.5), worstHourAvg: pr.base * 1.7,
          };
        });
      }
      case "get_heatmap": {
        const t = find(a.id); const pr = profiles.get(t.id)!;
        const cells = [];
        for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
          const evening = h >= 19 && h <= 22 ? 1 : 0;
          const r = rnd(d * 24 + h, 11);
          cells.push({ dow: d, hour: h, avg: pr.base * (1 + evening * 0.8 + r * 0.3), lossPct: pr.down ? 30 : evening * (pr.incident ? 6 : 1.2) * (d < 5 ? 1 : 0.4) + r * 0.3, count: 1440 });
        }
        return cells;
      }
      case "get_hop_timelines": {
        const t = find(a.id);
        const tr = trace(t, a.from, a.to);
        return tr.hops.map((h) => ({ ttl: h.ttl, addr: h.addr, hostname: h.hostname, points: timeline(t, h.ttl, a.from, a.to, a.points) }));
      }
      case "check_update": return null;
      case "update_source": return null;
      case "get_topology": return mockTopology();
      case "get_map_layout": { try { return localStorage.getItem("np.mock.map"); } catch { return null; } }
      case "save_map_layout": { try { localStorage.setItem("np.mock.map", a.layout); } catch { /* */ } return undefined; }
      case "project_page": return null;
      case "open_project_page": return undefined;
      case "export_report": return null;
      case "get_trace": return trace(find(a.id), a.from, a.to);
      case "get_diagnosis": return diagnosis(find(a.id), a.from, a.to);
      case "get_timeline": return timeline(find(a.id), a.ttl, a.from, a.to, a.points);
      case "get_timelines": {
        const out: Record<string, TimelinePoint[]> = {};
        for (const id of a.ids as string[]) {
          const t = targets.find((x) => x.id === id);
          if (t) out[id] = timeline(t, null, a.from, a.to, a.points);
        }
        return out;
      }
      case "get_uptime": return find(a.id).id === "demo-9" ? 97.9 : 99.6 + rnd(parseInt(a.id.replace(/\D/g, "")) || 1, 1) * 0.4;
      case "get_events": return [...events].sort((x, y) => y.ts - x.ts).filter((e) => !a.targetId || e.targetId === a.targetId).slice(0, a.limit);
      case "clear_events": events = []; return null;
      case "clear_history": if (a.withEvents) events = []; return null;
      case "history_stats": return { samples: 1843200, rollups: 64320, events: events.length, dbBytes: 187 * 1024 * 1024 };
      case "read_log": return "2026-01-01 10:00:00.000 INFO  [netpulse] демо-режим: журнал ведётся только в настоящей программе";
      case "get_settings": return structuredClone(settings);
      case "save_settings": settings = structuredClone(a.settings); targets.forEach(applyTpl); return null;
      case "set_template_targets": {
        let n = 0;
        for (const t of targets) {
          const want = a.ids.includes(t.id), has = t.templateId === a.templateId;
          if (want === has) continue;
          t.templateId = want ? a.templateId : null;
          applyTpl(t);
          n++;
        }
        return n;
      }
      case "test_channel":
        await new Promise((r) => setTimeout(r, 600));
        if (a.channel === "telegram" && !settings.channels.telegram.botToken) throw "не заполнены токен бота или chat_id";
        return null;
      case "test_system_notification":
        listeners.forEach((l) => l({ alert: { targetId: "", targetName: "", kind: "test", severity: "info", message: "Тестовое уведомление — всё работает ✅", notify: true }, sound: settings.channels.sound }));
        return null;
      case "export_csv": return 0;
      default: throw `mock: неизвестная команда ${cmd}`;
    }
  },
};

/** Демо-топология для работы в браузере: локалка, провайдер, интернет. */
function mockTopology() {
  const gw = "192.168.1.1";
  const isp = ["198.51.100.1", "198.51.100.9"];
  const transit = ["203.0.113.5", "203.0.113.34", "198.51.100.41", "198.51.100.42"];
  const hops: { ip: string; name: string | null; private: boolean; rtt: number | null; loss: number | null }[] = [];
  const add = (ip: string, rtt: number, loss: number | null = null, name: string | null = null) => {
    if (!hops.some((h) => h.ip === ip)) hops.push({ ip, name, private: /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip), rtt, loss });
  };
  add(gw, 0.6, 0, "gw.local");
  isp.forEach((ip, i) => add(ip, 2 + i, 0));
  transit.forEach((ip, i) => add(ip, 6 + i * 3, i === 1 ? 4 : 0));
  const routes = targets.filter((t) => t.enabled).map((t, i) => {
    const local = /^(10\.|192\.168\.|172\.)/.test(t.host) || t.host.endsWith(".local");
    const path = local ? [gw] : [gw, ...isp, ...transit.slice(0, 1 + (i % transit.length))];
    const s = profiles.get(t.id);
    return { targetId: t.id, hops: path, reached: !s?.down, at: now0, live: t.kind === "trace", reach: s?.down ? path.length - 1 : null };
  });
  return { localIp: "192.168.1.50", routes, hops, pending: 0 };
}
