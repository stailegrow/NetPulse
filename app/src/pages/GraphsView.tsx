import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { TargetSummary, TimelinePoint } from "../types";
import { KIND_LABEL } from "../types";
import { fmtMs, fmtPct, fmtTime, latencyClass, lossClass } from "../format";
import { problemText } from "../problem";

const fmtClock = (ts: number) => fmtTime(ts);
import { Timeline } from "../components/Timeline";
import { RouteBadge, MutedBadge, Dot } from "../components/ui";

const RANGES = [
  { l: "5 мин", ms: 5 * 60e3 },
  { l: "10 мин", ms: 10 * 60e3 },
  { l: "30 мин", ms: 30 * 60e3 },
  { l: "1 ч", ms: 3600e3 },
  { l: "6 ч", ms: 6 * 3600e3 },
  { l: "24 ч", ms: 24 * 3600e3 },
];
const HEIGHTS = [
  { l: "S", h: 44 },
  { l: "M", h: 70 },
  { l: "L", h: 120 },
];

function load<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? def : (JSON.parse(v) as T);
  } catch {
    return def;
  }
}
function save(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
}

interface Props {
  items: TargetSummary[];
  grouped: [string, TargetSummary[]][];
  showGroups: boolean;
  onOpen: (id: string) => void;
  onContext: (e: React.MouseEvent, s: TargetSummary) => void;
}

/**
 * Вид «Графики»: компактные таймлайны задержки и потерь всех целей друг под другом
 * на общей шкале времени (как рабочее пространство трассировщика с множеством целей).
 * Линия под курсором синхронизирована между всеми графиками.
 */
export function GraphsView({ items, grouped, showGroups, onOpen, onContext }: Props) {
  const [range, setRange] = useState<number>(() => load("np.graphRange", 10 * 60e3));
  const [rowH, setRowH] = useState<number>(() => load("np.graphHeight", 70));
  const [now, setNow] = useState(Date.now());
  const [data, setData] = useState<Record<string, TimelinePoint[]>>({});
  const [syncTs, setSyncTs] = useState<number | null>(null);
  // Приближение: выделенный на любом графике участок применяется ко всем графикам.
  const [zoom, setZoom] = useState<[number, number] | null>(null);

  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const idsKey = ids.join(",");
  const from = zoom ? zoom[0] : now - range;
  const to = zoom ? zoom[1] : now;
  const points = Math.min(700, Math.max(150, Math.round((window.innerWidth - 320) / 2)));

  useEffect(() => {
    if (zoom) return; // приближенный участок не обновляем — он в прошлом
    const t = setInterval(() => setNow(Date.now()), range <= 30 * 60e3 ? 2500 : 15000);
    return () => clearInterval(t);
  }, [range, zoom]);

  useEffect(() => {
    if (!ids.length) return;
    let alive = true;
    api.timelines(ids, from, to, points).then((d) => alive && setData(d)).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, now, range, points, zoom]);

  const row = (s: TargetSummary) => (
    <div key={s.id} className={"g-row " + s.health} onContextMenu={(e) => onContext(e, s)}>
      <div
        className="g-head"
        draggable
        onDragStart={(e) => { e.dataTransfer.setData("text/netpulse-target", s.id); e.dataTransfer.effectAllowed = "move"; }}
        onDoubleClick={() => onOpen(s.id)}
        title="Перетащите за эту строку в группу слева · двойной клик — подробности"
      >
        <Dot h={s.health} />
        <button className="g-name" onClick={() => onOpen(s.id)} title="Открыть подробности">{s.name}</button>
        <span className="g-host">{s.host}{s.resolvedIp && s.resolvedIp !== s.host ? ` (${s.resolvedIp})` : ""}</span>
        <span className="kind">{KIND_LABEL[s.kind]}</span>
        <MutedBadge on={s.alertsEnabled} />
        <RouteBadge at={s.routeChangedAt} text={s.routeChange} />
        <span style={{ flex: 1 }} />
        {problemText(s) && <span className={s.health === "down" || s.health === "dependent" ? "err" : "err warn"} title={problemText(s)}>{problemText(s)}</span>}
        <span className="g-stat">тек. <b className={"num " + (s.health === "paused" ? "c-dim" : latencyClass(s.lastRtt, s.thresholds))}>{s.lastRtt == null ? "✕" : fmtMs(s.lastRtt)}</b></span>
        <span className="g-stat">ср. <b className="num c-muted">{fmtMs(s.avgRtt)}</b></span>
        <span className="g-stat">jitter <b className="num c-muted">{fmtMs(s.jitter)}</b></span>
        <span className="g-stat">потери <b className={"num " + lossClass(s.lossPct, s.thresholds)}>{fmtPct(s.lossPct)}%</b></span>
      </div>
      <Timeline points={data[s.id] ?? []} from={from} to={to} th={s.thresholds} height={rowH} compact syncTs={syncTs} onHoverTs={setSyncTs} onFocus={setZoom} />
    </div>
  );

  return (
    <div className="graphs">
      <div className="graphs-bar">
        <div className="chips">
          {RANGES.map((r) => (
            <button key={r.ms} className={range === r.ms && !zoom ? "on" : ""} onClick={() => { setZoom(null); setNow(Date.now()); setRange(r.ms); save("np.graphRange", r.ms); }}>{r.l}</button>
          ))}
        </div>
        <span className="c-muted" style={{ fontSize: 12 }}>Высота</span>
        <div className="chips">
          {HEIGHTS.map((h) => (
            <button key={h.h} className={rowH === h.h ? "on" : ""} onClick={() => { setRowH(h.h); save("np.graphHeight", h.h); }}>{h.l}</button>
          ))}
        </div>
        {zoom && (
          <span className="pill" style={{ color: "var(--info)", borderColor: "rgba(90,169,255,.35)" }}>
            Приближено: {fmtClock(zoom[0])} – {fmtClock(zoom[1])}
            <button className="btn ghost sm" style={{ height: 18, padding: "0 4px" }} onClick={() => { setZoom(null); setNow(Date.now()); }}>✕</button>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="c-muted" style={{ fontSize: 11.5 }}>
          <i className="lg-line" />задержка <i className="lg-loss" />потери · выделите участок мышью — приблизить · двойной клик по графику — сброс
        </span>
      </div>
      {showGroups
        ? grouped.map(([g, list]) => (
            <div key={g}>
              <div className={"g-group" + (g === "\u0000problems" ? " problems" : "")}>{g === "\u0000problems" ? "Проблемные узлы" : g} <span className={"badge" + (g === "\u0000problems" ? " red" : "")}>{list.length}</span></div>
              {list.map(row)}
            </div>
          ))
        : items.map(row)}
    </div>
  );
}
