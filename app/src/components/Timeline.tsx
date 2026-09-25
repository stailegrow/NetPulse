import { useEffect, useMemo, useRef, useState } from "react";
import type { Thresholds, TimelinePoint } from "../types";
import { fmtDateTime, fmtMs, fmtPct, fmtTime } from "../format";

interface Props {
  points: TimelinePoint[];
  from: number;
  to: number;
  th: Thresholds;
  height?: number;
  focus?: [number, number] | null;
  onFocus?: (range: [number, number] | null) => void;
  /** Компактный режим для вида «Графики»: меньше отступов и сетки. */
  compact?: boolean;
  /** Время под курсором на соседнем графике — рисуем синхронную линию. */
  syncTs?: number | null;
  onHoverTs?: (ts: number | null) => void;
}

const PAD_FULL = { l: 44, r: 40, t: 8, b: 22 };
const PAD_COMPACT = { l: 36, r: 34, t: 3, b: 15 };
const LOSS_MAX = 30; // шкала потерь справа, %

function niceMax(v: number) {
  const steps = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 30000];
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

function label(ts: number, step: number) {
  const d = new Date(ts);
  if (step >= 86400e3) return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  if (step < 60e3) return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return d.getHours() === 0 && d.getMinutes() === 0 && step >= 3600e3 ? d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) : hm;
}

/**
 * Таймлайн задержки и потерь в стиле классических трассировщиков:
 * цветные зоны порогов, линия средней задержки, полоса min–max, красные столбцы потерь.
 * Перетаскивание мышью выделяет диапазон (фокус), двойной клик — сброс.
 */
export function Timeline({ points, from, to, th, height = 190, focus, onFocus, compact, syncTs, onHoverTs }: Props) {
  const PAD = compact ? PAD_COMPACT : PAD_FULL;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ x: number; p: TimelinePoint } | null>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Шкала задержки подбирается по данным, а не по порогам: иначе при пороге в сотни
  // миллисекунд реальные 5–20 мс превращаются в ровную линию по нижнему краю графика.
  const yMax = useMemo(() => {
    const vals = points.map((p) => p.max ?? p.avg ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
    if (!vals.length) return niceMax(Math.max(th.warnMs || 0, 5));
    const at = (q: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * q))];
    // Редкие одиночные всплески не растягивают шкалу: иначе обычные значения прижимаются
    // к нижнему краю. Всё, что выше, отмечается полосой превышения сверху.
    const peak = Math.min(at(0.98) * 1.2, at(0.9) * 3);
    // И не меньше двух медиан — ровный график должен идти по середине поля.
    return niceMax(Math.max(peak, at(0.5) * 2, 5));
  }, [points]);

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

    // Зоны порогов
    const zone = (a: number, b: number, color: string) => {
      if (a >= yMax) return;
      g.fillStyle = color;
      g.fillRect(PAD.l, yOf(Math.min(b, yMax)), plotW, yOf(a) - yOf(Math.min(b, yMax)));
    };
    const css = getComputedStyle(document.documentElement);
    zone(0, th.warnMs, css.getPropertyValue("--zone-ok"));
    zone(th.warnMs, th.badMs, css.getPropertyValue("--zone-warn"));
    zone(th.badMs, th.critMs, css.getPropertyValue("--zone-orange"));
    zone(th.critMs, yMax, css.getPropertyValue("--zone-bad"));

    // Сетка и подписи
    g.font = (compact ? "9.5px " : "10.5px ") + css.getPropertyValue("--mono");
    g.textBaseline = "middle";
    g.strokeStyle = "rgba(255,255,255,0.05)";
    g.lineWidth = 1;
    const rows = compact ? 2 : 4;
    for (let i = 0; i <= rows; i++) {
      if (compact && i === 0) continue;
      const v = (yMax / rows) * i;
      const y = Math.round(yOf(v)) + 0.5;
      g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(PAD.l + plotW, y); g.stroke();
      // Верхняя подпись иначе обрезается краем канвы.
      const ty = Math.max(y, PAD.t + 5);
      g.fillStyle = "#6c7682"; g.textAlign = "right";
      g.fillText(v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10), PAD.l - 6, ty);
      g.textAlign = "left"; g.fillStyle = "rgba(255,77,94,0.6)";
      g.fillText(`${Math.round((LOSS_MAX / rows) * i)}%`, PAD.l + plotW + 6, ty);
    }
    const { ticks, step } = timeTicks(from, to, plotW);
    g.textAlign = "center"; g.textBaseline = "top"; g.fillStyle = "#6c7682";
    for (const t of ticks) {
      const x = Math.round(xOf(t)) + 0.5;
      g.strokeStyle = "rgba(255,255,255,0.04)";
      g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, PAD.t + plotH); g.stroke();
      g.fillText(label(t, step), x, PAD.t + plotH + (compact ? 3 : 6));
    }

    const bucketW = points.length > 1 ? Math.max(1, plotW / Math.max(points.length, ((to - from) / Math.max(1, points[1].ts - points[0].ts)))) : 2;

    // Потери
    for (const p of points) {
      if (p.lossPct <= 0) continue;
      const x = xOf(p.ts);
      const h = (Math.min(p.lossPct, LOSS_MAX) / LOSS_MAX) * plotH;
      g.fillStyle = p.lossPct >= 100 ? "rgba(255,50,70,0.95)" : "rgba(255,77,94,0.8)";
      g.fillRect(x, PAD.t + plotH - h, Math.max(1.5, bucketW), h);
    }

    // Полоса min–max — разброс задержки вокруг средней.
    g.fillStyle = "rgba(53,224,138,0.16)";
    for (const p of points) {
      if (p.min == null || p.max == null) continue;
      const x = xOf(p.ts);
      const y1 = yOf(p.max), y2 = yOf(p.min);
      g.fillRect(x, y1, Math.max(1, bucketW), Math.max(1, y2 - y1));
    }

    // Средняя задержка: непрерывные отрезки без разрывов данных.
    const gap = points.length > 1 ? (points[1].ts - points[0].ts) * 2.5 : Infinity;
    const runs: [number, number][][] = [];
    let run: [number, number][] | null = null;
    let prevTs = 0;
    for (const p of points) {
      if (p.avg == null) { run = null; continue; }
      if (run && p.ts - prevTs > gap) run = null;
      if (!run) { run = []; runs.push(run); }
      run.push([xOf(p.ts) + bucketW / 2, yOf(p.avg)]);
      prevTs = p.ts;
    }

    const bottom = PAD.t + plotH;
    // Заливка под линией — график виден даже в строке высотой 44 пикселя.
    for (const r of runs) {
      if (r.length < 2) continue;
      const top = Math.min(...r.map((q) => q[1]));
      const grad = g.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, "rgba(53,224,138,0.26)");
      grad.addColorStop(1, "rgba(53,224,138,0.03)");
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(r[0][0], bottom);
      for (const [x, y] of r) g.lineTo(x, y);
      g.lineTo(r[r.length - 1][0], bottom);
      g.closePath();
      g.fill();
    }

    const lw = compact ? 1.7 : 2;
    g.lineJoin = "round";
    g.lineCap = "round";
    const stroke = (color: string, width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      for (const r of runs) {
        if (r.length < 2) continue;
        g.beginPath();
        g.moveTo(r[0][0], r[0][1]);
        for (let i = 1; i < r.length; i++) g.lineTo(r[i][0], r[i][1]);
        g.stroke();
      }
    };
    // Тёмная подложка отделяет линию от цветных зон и сетки.
    stroke("rgba(8,11,14,0.55)", lw + 2);
    stroke(css.getPropertyValue("--ok").trim() || "#35e08a", lw);

    // Одиночные точки между разрывами иначе не рисуются вовсе.
    g.fillStyle = css.getPropertyValue("--ok").trim() || "#35e08a";
    for (const r of runs) {
      if (r.length !== 1) continue;
      g.beginPath();
      g.arc(r[0][0], r[0][1], lw, 0, Math.PI * 2);
      g.fill();
    }

    // Превышение порогов отмечаем точками на линии, чтобы цвет графика оставался единым.
    for (const p of points) {
      if (p.avg == null || p.avg > yMax) continue;
      const c = p.avg >= th.critMs ? "--down" : p.avg >= th.badMs ? "--bad" : p.avg >= th.warnMs ? "--warn" : null;
      if (!c) continue;
      g.fillStyle = css.getPropertyValue(c).trim();
      g.beginPath();
      g.arc(xOf(p.ts) + bucketW / 2, yOf(p.avg), lw + 0.3, 0, Math.PI * 2);
      g.fill();
    }

    // Превышение шкалы
    g.fillStyle = "#ff9147";
    for (const p of points) if (p.avg != null && p.avg > yMax) g.fillRect(xOf(p.ts), PAD.t, Math.max(2, bucketW), 3);

    // Рамка
    g.strokeStyle = "#1b2128";
    g.lineWidth = 1;
    g.strokeRect(PAD.l + 0.5, PAD.t + 0.5, plotW - 1, plotH - 1);
  }, [points, from, to, width, height, yMax, th.warnMs, th.badMs, th.critMs, compact]);

  const nearest = (x: number) => {
    if (!points.length) return null;
    const ts = tsOf(x);
    let best = points[0];
    for (const p of points) if (Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p;
    return best;
  };

  const onMove = (e: React.MouseEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - r.left, PAD.l), PAD.l + plotW);
    const p = nearest(x);
    setHover(p ? { x, p } : null);
    onHoverTs?.(p ? tsOf(x) : null);
    if (drag) setDrag([drag[0], x]);
  };

  const onUp = () => {
    if (drag && onFocus && Math.abs(drag[1] - drag[0]) > 6) {
      const a = tsOf(Math.min(...drag)), b = tsOf(Math.max(...drag));
      onFocus([Math.round(a), Math.round(b)]);
    }
    setDrag(null);
  };

  const focusBox = focus && focus[1] > from && focus[0] < to
    ? { left: Math.max(PAD.l, xOf(focus[0])), right: Math.min(PAD.l + plotW, xOf(focus[1])) }
    : null;

  return (
    <div
      ref={wrap}
      style={{ position: "relative", height, cursor: onFocus ? "crosshair" : "default" }}
      onMouseMove={onMove}
      onMouseLeave={() => { setHover(null); setDrag(null); onHoverTs?.(null); }}
      onMouseDown={(e) => {
        const r = wrap.current!.getBoundingClientRect();
        const x = e.clientX - r.left;
        if (x >= PAD.l && x <= PAD.l + plotW) setDrag([x, x]);
      }}
      onMouseUp={onUp}
      onDoubleClick={() => onFocus?.(null)}
    >
      <canvas ref={canvas} style={{ width, height, display: "block" }} />
      {points.length === 0 && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--muted)", fontSize: 12.5, pointerEvents: "none" }}>Нет данных за выбранный период</div>
      )}
      {focusBox && (
        <div style={{ position: "absolute", top: PAD.t, height: plotH, left: focusBox.left, width: Math.max(2, focusBox.right - focusBox.left), background: "rgba(90,169,255,0.12)", borderLeft: "1px solid rgba(90,169,255,.7)", borderRight: "1px solid rgba(90,169,255,.7)", pointerEvents: "none" }} />
      )}
      {drag && (
        <div style={{ position: "absolute", top: PAD.t, height: plotH, left: Math.min(...drag), width: Math.abs(drag[1] - drag[0]), background: "rgba(53,224,138,0.14)", border: "1px dashed rgba(53,224,138,.6)", pointerEvents: "none" }} />
      )}
      {!hover && syncTs != null && syncTs >= from && syncTs <= to && (
        <div style={{ position: "absolute", top: PAD.t, height: plotH, left: xOf(syncTs), width: 1, background: "rgba(255,255,255,.28)", pointerEvents: "none" }} />
      )}
      {hover && !drag && (
        <>
          <div style={{ position: "absolute", top: PAD.t, height: plotH, left: hover.x, width: 1, background: "rgba(255,255,255,.35)", pointerEvents: "none" }} />
          {compact ? (
            <div className="chart-tip" style={{ top: -2, padding: "3px 8px", left: hover.x > width - 260 ? hover.x - 250 : hover.x + 10 }}>
              <span className="c-muted">{fmtTime(hover.p.ts)}</span>{" · "}
              {hover.p.avg == null ? <b className="c-down">нет ответа</b> : <><b className="num">{fmtMs(hover.p.avg, 1)} мс</b><span className="c-muted"> ({fmtMs(hover.p.min, 1)}–{fmtMs(hover.p.max, 1)})</span></>}{" · "}
              <span className={"num " + (hover.p.lossPct > 0 ? "c-down" : "c-muted")}>потери {fmtPct(hover.p.lossPct)}%</span>
            </div>
          ) : (
          <div className="chart-tip" style={{ top: 10, left: hover.x > width - 190 ? hover.x - 180 : hover.x + 12 }}>
            <div style={{ marginBottom: 4, color: "var(--text-2)" }}>{fmtDateTime(hover.p.ts)}</div>
            <div className="r"><span>Средн.</span><b className="num">{fmtMs(hover.p.avg, 1)} мс</b></div>
            <div className="r"><span>Мин / Макс</span><span className="num">{fmtMs(hover.p.min, 1)} / {fmtMs(hover.p.max, 1)}</span></div>
            <div className="r"><span>Потери</span><span className={"num " + (hover.p.lossPct > 0 ? "c-down" : "")}>{fmtPct(hover.p.lossPct)}%</span></div>
            <div className="r"><span>Сэмплов</span><span className="num">{hover.p.count}</span></div>
          </div>
          )}
        </>
      )}
    </div>
  );
}
