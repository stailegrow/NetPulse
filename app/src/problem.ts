import type { TargetSummary } from "./types";
import { fmtMs, fmtPct, plural } from "./format";
import { t } from "./i18n";

/**
 * Почему цель такого цвета — одной фразой.
 *
 * Цвет цели считает движок по порогам, а связный текст причины даёт анализатор.
 * Анализатор молчит, когда происходящее не похоже на аварию (например, стабильные
 * 59 мс до публичного DNS), — тогда фразу собираем из того самого порога, который
 * и дал цвет. Так на табло не остаётся слова «Внимание» без объяснения.
 */
export function problemText(s: TargetSummary): string {
  if (s.health === "dependent") return `${t("недоступен из-за")} «${s.blockedBy ?? "?"}»`;
  if (s.health === "down") return s.cause ?? s.lastError ?? t("нет ответа");
  if (s.health === "ok" || s.health === "paused" || s.health === "unknown") return "";
  return s.cause ?? breachText(s) ?? t("показатели хуже порога");
}

/** Нарушенный порог — ровно тот, из-за которого движок покрасил цель. */
export function breachText(s: TargetSummary): string | null {
  const th = s.thresholds;
  if (s.kind === "http" && s.statusCode != null && s.statusCode >= 400) {
    return `${t("сайт отвечает кодом")} ${s.statusCode}`;
  }
  // Порядок повторяет движок: сначала самый высокий уровень, при равенстве — потери.
  const list: [number, string][] = [];
  // Движок для потерь знает только два уровня: выше «красного» порога и выше «жёлтого».
  const loss = s.lossPct > th.badLoss ? 3 : s.lossPct > th.warnLoss ? 1 : 0;
  if (loss > 0) list.push([loss, `${t("потери")} ${fmtPct(s.lossPct)}%, ${t("порог")} ${fmtPct(th.warnLoss)}%`]);
  if (s.kind !== "http" && s.avgRtt != null) {
    const lat = level(s.avgRtt, th.warnMs, th.badMs, th.critMs);
    if (lat > 0) list.push([lat, `${t("средняя задержка")} ${fmtMs(s.avgRtt)} ${t("мс")}, ${t("порог")} ${fmtMs(th.warnMs)} ${t("мс")}`]);
    if (th.jitterWarn > 0 && s.jitter != null) {
      const j = level(s.jitter, th.jitterWarn, th.jitterCrit, th.jitterCrit);
      if (j > 0) list.push([j, `${t("джиттер")} ${fmtMs(s.jitter)} ${t("мс")}, ${t("порог")} ${fmtMs(th.jitterWarn)} ${t("мс")}`]);
    }
    if (th.mosWarn > 0 && s.mos != null && s.mos < th.mosWarn) {
      list.push([s.mos < th.mosCrit ? 3 : 1, `MOS ${s.mos.toFixed(2)}, ${t("порог")} ${th.mosWarn.toFixed(2)}`]);
    }
  }
  if (!list.length) return null;
  list.sort((a, b) => b[0] - a[0]);
  return list[0][1];
}

function level(v: number, warn: number, bad: number, crit: number) {
  return v > crit ? 3 : v > bad ? 2 : v > warn ? 1 : 0;
}

/** «так уже 14 минут» — сколько цель держится в текущем состоянии. */
export function sinceText(stateSince: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - stateSince) / 1000));
  if (sec < 60) return t("только что");
  const min = Math.round(sec / 60);
  if (min < 60) return `${t("так уже")} ${plural(min, "минуту", "минуты", "минут")}`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${t("так уже")} ${plural(h, "час", "часа", "часов")}`;
  return `${t("так уже")} ${plural(Math.floor(h / 24), "день", "дня", "дней")}`;
}

export type Trend = "up" | "flat" | "down";

/**
 * Куда движется задержка внутри окна спарклайна: сравниваем первую и последнюю треть.
 * Нужен, чтобы дежурный с пяти метров понимал — нарастает или уже отпускает.
 */
export function trend(spark: (number | null)[]): Trend | null {
  const v = spark.filter((x): x is number => x != null);
  if (v.length < 12) return null;
  const n = Math.floor(v.length / 3);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const first = avg(v.slice(0, n));
  const last = avg(v.slice(-n));
  if (first <= 0) return "flat";
  const d = (last - first) / first;
  return d > 0.25 ? "up" : d < -0.25 ? "down" : "flat";
}

export const TREND_TEXT: Record<Trend, string> = {
  up: "нарастает",
  flat: "держится ровно",
  down: "идёт на спад",
};

/** Потери всегда важнее задержки, авария важнее замедления. */
export function isProblem(h: TargetSummary["health"]) {
  return h === "down" || h === "dependent" || h === "crit" || h === "bad" || h === "warn";
}
