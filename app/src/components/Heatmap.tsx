import type { HeatCell, Thresholds } from "../types";
import { fmtMs, fmtPct } from "../format";

import { t } from "../i18n";

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Цвет ячейки: зелёный → жёлтый → оранжевый → красный по порогам цели. */
function color(c: HeatCell, metric: "avg" | "loss", th: Thresholds): string {
  if (!c.count) return "rgba(255,255,255,0.03)";
  if (metric === "loss") {
    const v = c.lossPct;
    if (v >= 99.5) return "rgba(255,50,70,0.95)";
    if (v > th.badLoss) return `rgba(255,77,94,${0.45 + Math.min(0.5, v / 100)})`;
    if (v > th.warnLoss) return "rgba(242,193,78,0.6)";
    // До половины жёлтого порога — зелёный, дальше — нарастающий жёлтый.
    if (v > th.warnLoss * 0.5) return `rgba(242,193,78,${0.2 + (v / Math.max(th.warnLoss, 0.1)) * 0.3})`;
    return `rgba(53,224,138,${0.3 - Math.min(0.12, (v / Math.max(th.warnLoss, 0.1)) * 0.24)})`;
  }
  if (c.avg == null) return "rgba(255,50,70,0.95)";
  const v = c.avg;
  if (!Number.isFinite(th.critMs)) return "rgba(90,169,255,0.35)";
  if (v > th.critMs) return "rgba(255,77,94,0.75)";
  if (v > th.badMs) return "rgba(255,145,71,0.6)";
  if (v > th.warnMs) return "rgba(242,193,78,0.5)";
  return `rgba(53,224,138,${0.14 + Math.min(0.4, (v / Math.max(th.warnMs, 0.1)) * 0.4)})`;
}

/** Тепловая карта «день недели × час»: видно, в какие часы стабильно проблемы. */
export function Heatmap({ cells, metric, th }: { cells: HeatCell[]; metric: "avg" | "loss"; th: Thresholds }) {
  const at = (d: number, h: number) => cells.find((c) => c.dow === d && c.hour === h);
  return (
    <div className="heatmap">
      <div className="hm-row hm-head">
        <span className="hm-day" />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="hm-h">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
      </div>
      {DAYS.map((d, di) => (
        <div className="hm-row" key={d}>
          <span className={"hm-day" + (di >= 5 ? " we" : "")}>{t(d)}</span>
          {Array.from({ length: 24 }, (_, h) => {
            const c = at(di, h);
            const tip = !c || !c.count
              ? `${d}, ${h}:00–${h + 1}:00 — нет данных`
              : `${d}, ${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00\nзадержка ${fmtMs(c.avg, 1)} мс · потери ${fmtPct(c.lossPct)}%\nпроверок: ${c.count}`;
            return <span key={h} className="hm-c" title={tip} style={{ background: c ? color(c, metric, th) : "rgba(255,255,255,0.03)" }} />;
          })}
        </div>
      ))}
    </div>
  );
}
