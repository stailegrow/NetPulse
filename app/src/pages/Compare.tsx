import { t } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { TargetSummary, TimelinePoint } from "../types";
import { KIND_LABEL } from "../types";
import { fmtMs, fmtPct } from "../format";
import { Dot, Icon } from "../components/ui";
import { MultiTimeline, SERIES_COLORS } from "../components/MultiTimeline";
import type { Metric, Series } from "../components/MultiTimeline";

const RANGES = [
  { l: "30 мин", ms: 30 * 60e3 },
  { l: "1 ч", ms: 3600e3 },
  { l: "6 ч", ms: 6 * 3600e3 },
  { l: "24 ч", ms: 86400e3 },
  { l: "7 дн", ms: 7 * 86400e3 },
  { l: "30 дн", ms: 30 * 86400e3 },
];
const MAX_SERIES = 12;

function load<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
}
function store(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ }
}

function stats(points: TimelinePoint[]) {
  let n = 0, sum = 0, cnt = 0, lostW = 0;
  let min: number | null = null, max: number | null = null;
  for (const p of points) {
    cnt += p.count;
    lostW += (p.lossPct / 100) * p.count;
    if (p.avg != null) { const w = Math.max(1, p.count * (1 - p.lossPct / 100)); sum += p.avg * w; n += w; }
    if (p.min != null) min = min == null ? p.min : Math.min(min, p.min);
    if (p.max != null) max = max == null ? p.max : Math.max(max, p.max);
  }
  return { avg: n ? sum / n : null, min, max, loss: cnt ? (lostW * 100) / cnt : 0 };
}

/** Сравнение нескольких целей на одном графике (например, ISP1 и ISP2 или DNS-серверы). */
export function Compare({ items, onOpen }: { items: TargetSummary[]; onOpen: (id: string) => void }) {
  const [selected, setSelected] = useState<string[]>(() => load("np.compare", []));
  const [range, setRange] = useState<number>(() => load("np.compareRange", 3600e3));
  const [metric, setMetric] = useState<Metric>(() => load("np.compareMetric", "avg"));
  const [q, setQ] = useState("");
  const [data, setData] = useState<Record<string, TimelinePoint[]>>({});
  const [now, setNow] = useState(Date.now());
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const ids = useMemo(() => selected.filter((id) => items.some((i) => i.id === id)), [selected, items]);
  const [from, to] = zoom ?? [now - range, now];

  useEffect(() => { store("np.compare", selected); }, [selected]);
  useEffect(() => { store("np.compareRange", range); setZoom(null); }, [range]);
  useEffect(() => { store("np.compareMetric", metric); }, [metric]);

  useEffect(() => {
    if (zoom) return;
    const t = setInterval(() => setNow(Date.now()), range <= 6 * 3600e3 ? 10000 : 60000);
    return () => clearInterval(t);
  }, [range, zoom]);

  useEffect(() => {
    if (!ids.length) { setData({}); return; }
    const points = Math.min(700, Math.max(150, Math.round(window.innerWidth / 2.5)));
    api.timelines(ids, from, to, points).then(setData).catch(() => {});
  }, [ids.join(","), from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const color = (id: string) => SERIES_COLORS[Math.max(0, ids.indexOf(id)) % SERIES_COLORS.length];
  const series: Series[] = ids
    .filter((id) => !hidden.has(id))
    .map((id) => {
      const s = items.find((i) => i.id === id)!;
      return { id, label: s.name, color: color(id), points: data[id] ?? [] };
    });

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX_SERIES ? cur : [...cur, id]));

  const ql = q.trim().toLowerCase();
  const grouped = useMemo(() => {
    const m = new Map<string, TargetSummary[]>();
    for (const i of items) {
      if (ql && !i.name.toLowerCase().includes(ql) && !i.host.toLowerCase().includes(ql)) continue;
      if (!m.has(i.group)) m.set(i.group, []);
      m.get(i.group)!.push(i);
    }
    return [...m.entries()];
  }, [items, ql]);

  const presets = [
    { l: "Все DNS", ids: items.filter((i) => i.kind === "dns").map((i) => i.id) },
    { l: "Каналы ISP", ids: items.filter((i) => /isp/i.test(i.name)).map((i) => i.id) },
  ].filter((p) => p.ids.length > 1);

  return (
    <div className="page-pad compare-layout">
      <div>
        <div style={{ position: "relative", marginBottom: 8 }}>
          <input className="input search" style={{ width: "100%", paddingLeft: 30 }} placeholder={t("Поиск цели")} value={q} onChange={(e) => setQ(e.target.value)} />
          <span style={{ position: "absolute", left: 9, top: 8, color: "var(--muted)" }}><Icon name="search" size={14} /></span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {presets.map((p) => <button key={p.l} className="btn sm" onClick={() => setSelected(p.ids.slice(0, MAX_SERIES))}>{p.l}</button>)}
          {selected.length > 0 && <button className="btn ghost sm" onClick={() => setSelected([])}>{t("Очистить")}</button>}
        </div>
        <div className="pick-list" style={{ maxHeight: "calc(100vh - 230px)" }}>
          {grouped.map(([g, list]) => (
            <div key={g}>
              <div className="pg">
                {g}
                <button className="btn ghost sm" style={{ height: 18, padding: "0 4px", fontSize: 10.5 }} onClick={() => setSelected((cur) => [...new Set([...cur, ...list.map((i) => i.id)])].slice(0, MAX_SERIES))}>{t("+ все")}</button>
              </div>
              {list.map((i) => (
                <label key={i.id}>
                  <input type="checkbox" checked={selected.includes(i.id)} onChange={() => toggle(i.id)} disabled={!selected.includes(i.id) && selected.length >= MAX_SERIES} />
                  {selected.includes(i.id) ? <i style={{ width: 9, height: 9, borderRadius: 2, background: color(i.id), flex: "none" }} /> : <Dot h={i.health} />}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.name}</span>
                  <span className="c-muted" style={{ marginLeft: "auto", fontSize: 10.5 }}>{KIND_LABEL[i.kind]}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="c-muted" style={{ fontSize: 11, marginTop: 6 }}>До {MAX_SERIES} целей на графике</div>
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <div className="chips">
            {RANGES.map((r) => <button key={r.ms} className={range === r.ms && !zoom ? "on" : ""} onClick={() => { setRange(r.ms); setZoom(null); }}>{r.l}</button>)}
          </div>
          <div className="chips">
            <button className={metric === "avg" ? "on" : ""} onClick={() => setMetric("avg")}>{t("Задержка")}</button>
            <button className={metric === "loss" ? "on" : ""} onClick={() => setMetric("loss")}>{t("Потери")}</button>
          </div>
          {zoom && (
            <span className="pill" style={{ color: "var(--info)", borderColor: "rgba(90,169,255,.35)" }}>
              Приближено
              <button className="btn ghost sm" style={{ height: 18, padding: "0 4px" }} onClick={() => setZoom(null)}>✕</button>
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span className="c-muted" style={{ fontSize: 11.5 }}>{t("выделите участок — приблизить · двойной клик — сброс")}</span>
        </div>

        {!ids.length ? (
          <div className="empty" style={{ minHeight: 320 }}>
            <h2>{t("Выберите цели слева")}</h2>
            <div>{t("Например, два канала провайдеров или несколько DNS-серверов — их задержка и потери появятся на одном графике.")}</div>
          </div>
        ) : (
          <>
            <div className="chart-card">
              <MultiTimeline series={series} from={from} to={to} metric={metric} height={320} onFocus={setZoom} />
              <div className="series-legend">
                {ids.map((id) => {
                  const s = items.find((i) => i.id === id)!;
                  return (
                    <button key={id} className={hidden.has(id) ? "off" : ""} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; })} title={t("Скрыть / показать линию")}>
                      <i style={{ background: color(id) }} /><span>{s.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <table className="grid" style={{ marginTop: 12 }}>
              <thead>
                <tr><th>{t("Цель")}</th><th>{t("Тип")}</th><th className="r">{t("Средн., мс")}</th><th className="r">{t("Мин")}</th><th className="r">{t("Макс")}</th><th className="r">{t("Потери")}</th><th className="r">{t("Сейчас")}</th></tr>
              </thead>
              <tbody>
                {[...ids]
                  .map((id) => ({ id, s: items.find((i) => i.id === id)!, st: stats(data[id] ?? []) }))
                  .sort((a, b) => (a.st.avg ?? 1e9) - (b.st.avg ?? 1e9))
                  .map(({ id, s, st }, idx) => (
                    <tr key={id} onClick={() => onOpen(id)}>
                      <td><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: color(id) }} />{s.name}{idx === 0 && st.avg != null && ids.length > 1 && <span className="pill ok" style={{ height: 18 }}>{t("быстрее всех")}</span>}</span></td>
                      <td><span className="kind">{KIND_LABEL[s.kind]}</span></td>
                      <td className="r num" style={{ fontWeight: 600 }}>{fmtMs(st.avg, 1)}</td>
                      <td className="r num c-muted">{fmtMs(st.min, 1)}</td>
                      <td className="r num c-muted">{fmtMs(st.max, 1)}</td>
                      <td className={"r num " + (st.loss > 5 ? "c-down" : st.loss > 0.5 ? "c-warn" : "c-muted")}>{fmtPct(st.loss)}%</td>
                      <td className="r num">{s.lastRtt == null ? <span className="c-down">✕</span> : fmtMs(s.lastRtt, 1)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
