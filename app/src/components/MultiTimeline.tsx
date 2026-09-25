import { t } from "../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelinePoint } from "../types";
import { fmtDateTime, fmtMs, fmtPct } from "../format";

export interface Series {
  id: string;
  label: string;
  color: string;
  points: TimelinePoint[];
}

export type Metric = "avg" | "loss";

/** Цвета линий: хорошо различимы на чёрном фоне. */
export const SERIES_COLORS = ["#35e08a", "#5aa9ff", "#f2c14e", "#ff7ab6", "#b48cff", "#ff9147", "#4fd6d6", "#e8ecf1", "#9fd356", "#ff5f6d", "#c9a3a8", "#7aa2ff"];

const PAD = { l: 48, r: 16, t: 10, b: 22 };

function niceMax(v: number) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 20000, 30000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 10000) * 10000;
}

function timeTicks(from: number, to: number, px: number) {
  const span = to - from;
  const cands = [10e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 2 * 86400e3, 7 * 86400e3];
  const step = cands.find((c) => (span / c) * 90 <= px) ?? 14 * 86400e3;
  const tz = new Date().getTimezoneOffset() * 60e3;
  const out: number[] = [];
  for (let t = Math.ceil((from - tz) / step) * step + tz; t <= to; t += step) out.push(t);
  return { ticks: out, step };
}

function tickLabel(ts: number, step: number) {
  const d = new Date(ts);
  if (step >= 86400e3) return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** Несколько линий на одном графике: сравнение целей или хопов маршрута. */
export function MultiTimeline({ series, from, to, metric, height = 280, onFocus }: {
  series: Series[];
  from: number;
  to: number;
  metric: Metric;
  height?: number;
  onFocus?: (r: [number, number] | null) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const val = (p: TimelinePoint) => (metric === "avg" ? p.avg : p.lossPct);

  const yMax = useMemo(() => {
    const vals: number[] = [];
    for (const s of series) for (const p of s.points) { const v = val(p); if (v != null && v > 0) vals.push(v); }
    vals.sort((a, b) => a - b);
    const p99 = vals.length ? vals[Math.floor(vals.length * 0.99)] : 0;
    return niceMax(Math.max(metric === "loss" ? 5 : 2, p99 * 1.15));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, metric]);

  const plotW = Math.max(10, width - PAD.l - PAD.r);
  const plotH = height - PAD.t - PAD.b;
  const xOf = (ts: number) => PAD.l + ((ts - from) / (to - from)) * plotW;
  const tsOf = (x: number) => from + ((x - PAD.l) / plotW) * (to - from);
  const yOf = (v: number) => PAD.t + plotH - (Math.min(v, yMax) / yMax) * plotH;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const css = getComputedStyle(document.documentElement);
    g.font = "10.5px " + css.getPropertyValue("--mono");

    // сетка
    g.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const v = (yMax / 4) * i;
      const y = Math.round(yOf(v)) + 0.5;
      g.strokeStyle = "rgba(255,255,255,0.05)";
      g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(PAD.l + plotW, y); g.stroke();
      g.fillStyle = "#6c7682"; g.textAlign = "right";
      g.fillText(metric === "loss" ? `${Math.round(v)}%` : String(v < 10 ? +v.toFixed(1) : Math.round(v)), PAD.l - 6, y);
    }
    const { ticks, step } = timeTicks(from, to, plotW);
    g.textAlign = "center"; g.textBaseline = "top";
    for (const t of ticks) {
      const x = Math.round(xOf(t)) + 0.5;
      g.strokeStyle = "rgba(255,255,255,0.04)";
      g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, PAD.t + plotH); g.stroke();
      g.fillStyle = "#6c7682";
      g.fillText(tickLabel(t, step), x, PAD.t + plotH + 6);
    }

    // линии
    for (const s of series) {
      const pts = s.points;
      if (!pts.length) continue;
      const gap = pts.length > 1 ? (pts[1].ts - pts[0].ts) * 2.5 : Infinity;
      g.strokeStyle = s.color;
      g.lineWidth = 1.5;
      g.lineJoin = "round";
      g.beginPath();
      let pen = false;
      let prev = 0;
      for (const p of pts) {
        const v = val(p);
        if (v == null || (pen && p.ts - prev > gap)) { pen = false; if (v == null) continue; }
        const x = xOf(p.ts), y = yOf(v);
        if (pen) g.lineTo(x, y); else g.moveTo(x, y);
        pen = true; prev = p.ts;
      }
      g.stroke();
    }
    g.strokeStyle = "#1b2128";
    g.strokeRect(PAD.l + 0.5, PAD.t + 0.5, plotW - 1, plotH - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, from, to, width, height, yMax, metric]);

  const hover = useMemo(() => {
    if (hoverX == null) return null;
    const ts = tsOf(hoverX);
    const rows = series.map((s) => {
      let best: TimelinePoint | null = null;
      for (const p of s.points) if (!best || Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p;
      return { s, p: best };
    });
    return { ts, rows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverX, series]);

  return (
    <div
      ref={wrap}
      style={{ position: "relative", height, cursor: onFocus ? "crosshair" : "default" }}
      onMouseMove={(e) => {
        const r = wrap.current!.getBoundingClientRect();
        const x = Math.min(Math.max(e.clientX - r.left, PAD.l), PAD.l + plotW);
        setHoverX(x);
        if (drag) setDrag([drag[0], x]);
      }}
      onMouseLeave={() => { setHoverX(null); setDrag(null); }}
      onMouseDown={(e) => {
        if (!onFocus) return;
        const r = wrap.current!.getBoundingClientRect();
        const x = e.clientX - r.left;
        if (x >= PAD.l && x <= PAD.l + plotW) setDrag([x, x]);
      }}
      onMouseUp={() => {
        if (drag && onFocus && Math.abs(drag[1] - drag[0]) > 6) onFocus([Math.round(tsOf(Math.min(...drag))), Math.round(tsOf(Math.max(...drag)))]);
        setDrag(null);
      }}
      onDoubleClick={() => onFocus?.(null)}
    >
      <canvas ref={canvas} style={{ width, height, display: "block" }} />
      {drag && (
        <div style={{ position: "absolute", top: PAD.t, height: plotH, left: Math.min(...drag), width: Math.abs(drag[1] - drag[0]), background: "rgba(53,224,138,0.14)", border: "1px dashed rgba(53,224,138,.6)", pointerEvents: "none" }} />
      )}
      {hover && hoverX != null && !drag && (
        <>
          <div style={{ position: "absolute", top: PAD.t, height: plotH, left: hoverX, width: 1, background: "rgba(255,255,255,.35)", pointerEvents: "none" }} />
          <div className="chart-tip" style={{ top: 10, left: hoverX > width - 260 ? hoverX - 250 : hoverX + 12, minWidth: 220 }}>
            <div style={{ marginBottom: 4, color: "var(--text-2)" }}>{fmtDateTime(hover.ts)}</div>
            {hover.rows.map(({ s, p }) => (
              <div className="r" key={s.id}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 170 }}>
                  <i style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flex: "none" }} />{s.label}
                </span>
                <b className="num">
                  {p == null ? "—" : metric === "avg" ? (p.avg == null ? <span className="c-down">{t("нет ответа")}</span> : `${fmtMs(p.avg, 1)} мс`) : `${fmtPct(p.lossPct)}%`}
                </b>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
