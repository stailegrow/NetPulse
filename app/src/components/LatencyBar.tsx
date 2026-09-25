import type { HopStats, Thresholds } from "../types";
import { LEVEL_COLOR, latencyLevel } from "../format";

/** Ячейка «Latency» таблицы хопов: зоны порогов, диапазон min–max, точка среднего. */
export function LatencyBar({ hop, th, scaleMax, prevAvg }: { hop: HopStats; th: Thresholds; scaleMax: number; prevAvg: number | null }) {
  const pct = (v: number) => `${Math.min(100, (v / scaleMax) * 100)}%`;
  const color = hop.avg == null ? "var(--down)" : LEVEL_COLOR[latencyLevel(hop.avg, th)];
  return (
    <div style={{ position: "relative", height: 24 }}>
      <div style={{ position: "absolute", inset: "0", display: "flex", opacity: 0.9 }}>
        <div style={{ width: pct(th.warnMs), background: "var(--zone-ok)" }} />
        <div style={{ width: `calc(${pct(th.badMs)} - ${pct(th.warnMs)})`, background: "var(--zone-warn)" }} />
        <div style={{ width: `calc(${pct(th.critMs)} - ${pct(th.badMs)})`, background: "var(--zone-orange)" }} />
        <div style={{ flex: 1, background: "var(--zone-bad)" }} />
      </div>
      {hop.lossPct > 0 && (
        <div title={`Потери ${hop.lossPct.toFixed(1)}%`} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, hop.lossPct)}%`, background: "linear-gradient(90deg, rgba(255,77,94,.28), rgba(255,77,94,.08))" }} />
      )}
      {hop.min != null && hop.max != null && (
        <div style={{ position: "absolute", top: 11, height: 2, left: pct(hop.min), width: `calc(${pct(hop.max)} - ${pct(hop.min)})`, background: "rgba(220,230,240,.35)" }} />
      )}
      {prevAvg != null && hop.avg != null && (
        <div style={{ position: "absolute", top: 12, height: 0, left: pct(Math.min(prevAvg, hop.avg)), width: `calc(${pct(Math.max(prevAvg, hop.avg))} - ${pct(Math.min(prevAvg, hop.avg))})`, borderTop: "1px dashed rgba(233,238,243,.25)" }} />
      )}
      {hop.avg != null && (
        <div style={{ position: "absolute", top: 7, width: 10, height: 10, marginLeft: -5, borderRadius: 5, left: pct(hop.avg), background: color, boxShadow: `0 0 8px ${color}` }} />
      )}
    </div>
  );
}
