import type { Thresholds } from "../types";
import { LEVEL_COLOR, latencyLevel } from "../format";

/** Мини-график последних сэмплов: линия задержки + красные штрихи потерь. */
export function Sparkline({ data, th, width = 150, height = 26 }: { data: (number | null)[]; th: Thresholds; width?: number; height?: number }) {
  if (!data.length) return <svg width={width} height={height} />;
  const vals = data.filter((v): v is number => v != null);
  const max = Math.max(Number.isFinite(th.warnMs) ? th.warnMs * 0.6 : 1, ...vals) * 1.1;
  const n = Math.max(data.length, 60);
  const dx = width / (n - 1);
  const off = n - data.length;
  const y = (v: number) => height - 2 - (v / max) * (height - 4);
  let path = "";
  let pen = false;
  data.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    path += `${pen ? "L" : "M"}${((i + off) * dx).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const warnY = th.warnMs < max ? y(th.warnMs) : null;
  const color = vals.length ? LEVEL_COLOR[latencyLevel(vals[vals.length - 1], th)] : "var(--ok)";
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {warnY != null && <line x1={0} x2={width} y1={warnY} y2={warnY} stroke="rgba(242,193,78,.18)" strokeDasharray="2 3" />}
      {data.map((v, i) => v == null ? <rect key={i} x={(i + off) * dx - 1} y={0} width={2} height={height} fill="var(--down)" opacity={0.85} /> : null)}
      <path d={path} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}
