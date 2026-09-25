import type { Thresholds } from "./types";

export const fmtMs = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v < 10 && digits === 0 ? v.toFixed(1) : v.toFixed(digits);

export const fmtPct = (v: number | null | undefined) =>
  v == null ? "—" : v === 0 ? "0" : v < 1 ? v.toFixed(1) : v.toFixed(0);

export const fmtTime = (ts: number, withSeconds = true) =>
  new Date(ts).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
  });

export const fmtDateTime = (ts: number) =>
  new Date(ts).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export const fmtInterval = (ms: number) =>
  ms < 1000 ? `${ms} мс` : ms < 60000 ? `${+(ms / 1000).toFixed(1)} с` : `${+(ms / 60000).toFixed(1)} мин`;

export function ago(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  return `${Math.round(s / 3600)} ч назад`;
}

/** Уровень задержки: 0 — норма, 1 — жёлтый, 2 — оранжевый, 3 — красный. */
export function latencyLevel(v: number, th: Thresholds) {
  return v > th.critMs ? 3 : v > th.badMs ? 2 : v > th.warnMs ? 1 : 0;
}

export const LEVEL_COLOR = ["var(--ok)", "var(--warn)", "var(--bad)", "var(--down)"];

/** Цвет задержки по порогам. */
export function latencyClass(v: number | null, th: Thresholds) {
  if (v == null) return "c-down";
  return ["c-ok", "c-warn", "c-bad", "c-down"][latencyLevel(v, th)];
}

/** Цвет потерь: до warnLoss — норма, до badLoss — жёлтый, выше — красный. */
export function lossClass(v: number, th: Thresholds) {
  if (v > th.badLoss) return "c-down";
  if (v > th.warnLoss) return "c-warn";
  if (v > 0) return "c-muted";
  return "c-dim";
}

/** Русские склонения: plural(3, "цель", "цели", "целей") → «3 цели». */
export function plural(n: number, one: string, few: string, many: string) {
  const n10 = n % 10;
  const n100 = n % 100;
  const w = n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  return `${n} ${w}`;
}
