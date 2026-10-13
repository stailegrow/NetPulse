import { useEffect, useMemo, useRef, useState } from "react";
import type { EventRecord, Health, TargetSummary, TimelinePoint } from "../types";
import { fmtMs, fmtPct, plural } from "../format";
import { isProblem, problemText, trend } from "../problem";
import { api } from "../api";
import { t } from "../i18n";
import { EvIcon, stripMark } from "./ui";

/** Группа на дашборде: имя и её цели (без выключенных). */
export type WallGroup = [string, TargetSummary[]];

type Tone = "ok" | "warn" | "bad" | "down" | "dep" | "dim";
const tone = (h: Health): Tone =>
  h === "ok" ? "ok" : h === "warn" ? "warn" : h === "bad" ? "bad" : h === "crit" || h === "down" ? "down" : h === "dependent" ? "dep" : "dim";
const SEV: Record<Tone, number> = { down: 0, dep: 1, bad: 2, warn: 3, dim: 4, ok: 5 };

/** «38 мин», «2 ч 05 мин», «1 д 3 ч». */
function dur(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return `${Math.max(1, Math.floor(ms / 1000))} с`;
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч ${String(m % 60).padStart(2, "0")} мин`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
}

/** Где разрыв — по выводу анализатора трассировки. */
function where(s: TargetSummary): { cls: string; text: string } | null {
  if (s.health === "dependent" && s.blockedBy) return { cls: "dep", text: `из-за «${s.blockedBy}»` };
  const c = (s.cause ?? "").toLowerCase();
  if (!c) return s.health === "down" ? { cls: "node", text: t("нет ответа") } : null;
  if (c.includes("оператор") || c.includes("провайдер") || c.includes("транзит")) return { cls: "isp", text: s.cause! };
  if (c.includes("сам узел") || c.includes("не отвечает сам")) return { cls: "node", text: s.cause! };
  if (c.includes("наш") || c.includes("шлюз") || c.includes("локальн") || c.includes("этот компьютер")) return { cls: "lan", text: s.cause! };
  return { cls: "", text: s.cause! };
}

/** Состояние минуты по истории: потери и задержка относительно порогов цели. */
function bucketTone(p: TimelinePoint | undefined, s: TargetSummary): Tone {
  if (!p || p.count === 0) return "dim";
  if (p.lossPct >= 99) return "down";
  const th = s.thresholds;
  if (p.lossPct > th.badLoss) return "bad";
  if (p.lossPct > th.warnLoss) return "warn";
  if (p.avg != null && s.kind !== "http" && p.avg > th.critMs) return "warn";
  return "ok";
}

const LANE_SPAN = 3 * 3600e3;
const LANE_POINTS = 90;

/**
 * «Пульт дежурного»: что сломано и где разрыв, журнал за час и полосы состояния
 * групп за три часа. Экран для аварии: сначала проблемы, потом всё остальное.
 */
export function WbConsole({ active, groups, now, onOpen }: { active: TargetSummary[]; groups: WallGroup[]; now: number; onOpen: (id: string) => void }) {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [lanes, setLanes] = useState<Record<string, TimelinePoint[]>>({});
  const [today, setToday] = useState<number | null>(null);
  const [laneAt, setLaneAt] = useState(Date.now());
  const ids = useMemo(() => active.map((x) => x.id).sort().join(","), [active]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      const to = Date.now();
      api.events(300).then((l) => alive && setEvents(l)).catch(() => {});
      if (ids) api.timelines(ids.split(","), to - LANE_SPAN, to, LANE_POINTS).then((d) => { if (alive) { setLanes(d); setLaneAt(to); } }).catch(() => {});
      const d0 = new Date(); d0.setHours(0, 0, 0, 0);
      api.report(d0.getTime(), to).then((rows) => {
        const ch = rows.reduce((a, r) => a + r.checks, 0);
        const lost = rows.reduce((a, r) => a + r.lost, 0);
        if (alive) setToday(ch ? 100 - (lost * 100) / ch : null);
      }).catch(() => {});
    };
    load();
    const h = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(h); };
  }, [ids]);

  const probs = useMemo(() => active.filter((x) => isProblem(x.health) && x.health !== "dependent")
    .sort((a, b) => SEV[tone(a.health)] - SEV[tone(b.health)] || a.stateSince - b.stateSince), [active]);
  const deps = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of active) if (x.health === "dependent" && x.blockedBy) m.set(x.blockedBy, (m.get(x.blockedBy) ?? 0) + 1);
    return m;
  }, [active]);
  const touched = active.filter((x) => isProblem(x.health)).length;
  const hour = events.filter((e) => e.ts > now - 3600e3);
  const flaps = hour.filter((e) => e.kind === "outage" || e.kind === "down").length;
  const routes = hour.filter((e) => e.kind === "route").length;
  const recent = events.filter((e) => e.ts > now - 3 * 3600e3 && e.kind !== "channel_error").slice(0, 14);

  // Полосы: худшее состояние группы в каждой точке.
  const laneRows = useMemo(() => groups.map(([g, list]) => {
    const cells: Tone[] = Array.from({ length: LANE_POINTS }, () => "dim");
    const step = LANE_SPAN / LANE_POINTS;
    const from = laneAt - LANE_SPAN;
    for (const s of list) {
      for (const p of lanes[s.id] ?? []) {
        const i = Math.min(LANE_POINTS - 1, Math.max(0, Math.floor((p.ts - from) / step)));
        const v = bucketTone(p, s);
        if (cells[i] === "dim" || SEV[v] < SEV[cells[i]]) cells[i] = v;
      }
    }
    const bad = list.filter((x) => isProblem(x.health)).length;
    return { g, cells, bad, n: list.length };
  }).sort((a, b) => b.bad - a.bad || b.n - a.n), [groups, lanes, laneAt]);
  const laneCols = laneRows.length > 10 ? 2 : 1;
  const ticks = [0, 1, 2, 3, 4, 5, 6].map((k) => new Date(laneAt - LANE_SPAN + (k * LANE_SPAN) / 6).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));

  const sumClass = probs.some((p) => tone(p.health) === "down") ? "down" : probs.length ? "warn" : "ok";
  return (
    <div className={"wc " + sumClass}>
      <div className="wc-kpis">
        <div className={"wc-kpi " + (today == null ? "" : today >= 99.9 ? "ok" : today >= 99 ? "warn" : "down")}>
          <span>{t("Доступность сегодня")}</span><b className="num">{today == null ? "—" : `${today.toFixed(today >= 99.95 ? 3 : 2).replace(".", ",")}%`}</b>
        </div>
        <div className={"wc-kpi " + (probs.length ? sumClass : "ok")}>
          <span>{t("Проблем сейчас")}</span><b className="num">{probs.length}</b>
        </div>
        <div className={"wc-kpi " + (touched ? sumClass : "ok")}>
          <span>{t("Узлов задето")}</span><b className="num">{touched}<small>/{active.length}</small></b>
        </div>
        <div className={"wc-kpi " + (flaps ? "warn" : "ok")}>
          <span>{t("Пропадали за час")}</span><b className="num">{flaps}</b>
        </div>
        <div className={"wc-kpi " + (routes ? "route" : "ok")}>
          <span>{t("Смены маршрута за час")}</span><b className="num">{routes}</b>
        </div>
      </div>

      <div className="wc-mid">
        <section className="wc-pan wc-probs">
          <div className="wc-ph"><span>{t("Сейчас не в порядке")}</span><span>{probs.length ? t("по важности") : ""}</span></div>
          {probs.length === 0 ? (
            <div className="wc-calm">
              <svg viewBox="0 0 24 24" width="54" height="54" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z" /><path d="M8 12.5l2.7 2.7L16.5 9.5" /></svg>
              <b>{t("Всё в порядке")}</b>
              <span>{plural(active.length, "цель отвечает", "цели отвечают", "целей отвечают")} {t("в пределах порогов")}</span>
              {hour.length > 0 && <small>{t("За последний час событий")}: {hour.length}</small>}
            </div>
          ) : (
            <div className="wc-tablewrap">
              <table className="wc-t">
                <thead>
                  <tr><th /><th>{t("Узел")}</th><th>{t("Где разрыв")}</th><th className="r">{t("Длится")}</th><th className="r">{t("Задержка")}</th><th className="r">{t("Потери")}</th><th className="r">{t("Тренд")}</th></tr>
                </thead>
                <tbody>
                  {probs.map((s) => {
                    const tn = tone(s.health);
                    const w = where(s);
                    const tr = s.health === "down" ? null : trend(s.spark);
                    const extra = deps.get(s.name);
                    return (
                      <tr key={s.id} className={tn} onClick={() => onOpen(s.id)}>
                        <td className="wc-sev"><i /></td>
                        <td className="wc-node"><b>{s.name}</b><small>{s.group}{extra ? ` · +${plural(extra, "зависимый", "зависимых", "зависимых")}` : ""}</small></td>
                        <td className="wc-where">{w ? <span className={"wc-w " + w.cls}>{w.text}</span> : <span className="c-muted">{problemText(s)}</span>}</td>
                        <td className="r num wc-dur">{dur(now - s.stateSince)}</td>
                        <td className="r num">{s.lastRtt == null ? <span className="c-down">✕</span> : <>{fmtMs(s.lastRtt, 1)}<small> мс</small></>}</td>
                        <td className={"r num " + (s.lossPct >= s.thresholds.badLoss ? "c-down" : s.lossPct >= s.thresholds.warnLoss ? "c-warn" : "c-muted")}>{fmtPct(s.lossPct)}%</td>
                        <td className={"r wc-tr " + (tr ?? "none")} title={tr ? t(tr === "up" ? "нарастает" : tr === "down" ? "идёт на спад" : "держится ровно") : ""}>{tr === "up" ? "↗" : tr === "down" ? "↘" : tr === "flat" ? "→" : "·"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="wc-pan wc-log">
          <div className="wc-ph"><span>{t("Журнал")}</span><span>{t("3 часа")}</span></div>
          {recent.length === 0 && <div className="c-muted wc-empty">{t("Событий не было")}</div>}
          {recent.map((e) => (
            <button key={e.id} className="wc-ev" onClick={() => e.targetId && onOpen(e.targetId)}>
              <span className="num">{new Date(e.ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
              <EvIcon kind={e.kind} severity={e.severity} size={20} />
              <span className="wc-evt">{stripMark(e.message).split("\n")[0]}</span>
            </button>
          ))}
        </section>
      </div>

      <section className="wc-pan wc-lanes">
        <div className="wc-ph"><span>{t("Состояние групп за 3 часа")}</span><span className="wc-leg"><i className="ok" />{t("норма")}<i className="warn" />{t("задержка, потери")}<i className="down" />{t("нет связи")}<i className="dim" />{t("нет данных")}</span></div>
        <div className="wc-lane-grid" style={{ gridTemplateColumns: `repeat(${laneCols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.max(1, Math.ceil(laneRows.length / laneCols))}, minmax(0, 1fr))` }}>
          {laneRows.map((r) => (
            <div key={r.g} className="wc-lane">
              <span className={"wc-ln" + (r.bad ? " hit" : "")}>{r.g}</span>
              <div className="wc-strip">{r.cells.map((c, i) => <i key={i} className={c} />)}</div>
            </div>
          ))}
        </div>
        <div className="wc-axes" style={{ gridTemplateColumns: `repeat(${laneCols}, minmax(0, 1fr))` }}>
          {Array.from({ length: laneCols }, (_, c) => (
            <div key={c} className="wc-axis num"><span className="wc-axis-pad" /><div>{ticks.map((x, i) => <span key={i}>{i === 6 ? t("сейчас") : x}</span>)}</div></div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ «Бенто» */

/** Цвет узла в норме: чем ближе задержка к порогу, тем теплее оттенок. */
function okHue(s: TargetSummary): number {
  const v = s.lastRtt ?? s.avgRtt;
  if (v == null || s.kind === "http") return 155;
  const r = Math.max(0, Math.min(1, v / Math.max(1, s.thresholds.warnMs)));
  return 158 - r * 70;
}

/** Мини-график группы: средняя задержка её узлов по последним проверкам. */
function groupSpark(list: TargetSummary[], n = 48): number[] {
  const out: number[] = [];
  for (let k = n; k >= 1; k--) {
    let sum = 0, cnt = 0;
    for (const x of list) { const v = x.spark[x.spark.length - k]; if (v != null) { sum += v; cnt++; } }
    out.push(cnt ? sum / cnt : 0);
  }
  return out;
}

function TileSpark({ v, cls }: { v: number[]; cls: string }) {
  const w = 200, h = 50;
  const max = Math.max(1, ...v);
  if (v.every((x) => x === 0)) return null;
  const d = v.map((x, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - (x / max) * (h - 8)).toFixed(1)}`).join(" ");
  return (
    <svg className={"wbb-spark " + cls} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path d={`${d} L${w},${h} L0,${h} Z`} className="a" />
      <path d={d} className="l" />
    </svg>
  );
}

/**
 * «Бенто»: стеклянные плитки групп, внутри каждой — квадрат на каждый узел.
 * Квадрат живой: цвет — состояние, оттенок — задержка, у проблемных — свечение и пульс.
 * Плитка с проблемой подсвечивается и встаёт первой; слева — общий итог и список проблем.
 */
export function WbBento({ active, groups, now, onOpen }: { active: TargetSummary[]; groups: WallGroup[]; now: number; onOpen: (id: string) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [sq, setSq] = useState(30);
  const probs = active.filter((x) => isProblem(x.health)).sort((a, b) => SEV[tone(a.health)] - SEV[tone(b.health)] || a.stateSince - b.stateSince);
  const down = probs.filter((x) => tone(x.health) === "down" || tone(x.health) === "dep").length;
  const st = down ? "down" : probs.length ? "warn" : "ok";
  const ok = active.filter((x) => x.health === "ok").length;
  const pct = active.length ? (ok * 100) / active.length : 100;

  // Размер квадрата подбираем по реальной раскладке: двоичный поиск наибольшего размера,
  // при котором все плитки помещаются без прокрутки. Перезапуск — при смене размера окна и состава.
  const [probe, setProbe] = useState<{ lo: number; hi: number; best: number } | null>(null);
  const restart = () => { setProbe({ lo: 12, hi: 96, best: 12 }); setSq(54); };
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    restart();
    let first = true;
    const ro = new ResizeObserver(() => { if (first) { first = false; return; } restart(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [active.length, groups.length]);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !probe || el.clientHeight < 40) return;
    const id = requestAnimationFrame(() => {
      const fits = el.scrollHeight <= el.clientHeight + 1;
      let { lo, hi, best } = probe;
      if (fits) { best = sq; lo = sq + 1; } else hi = sq - 1;
      if (lo > hi) { setProbe(null); setSq(best); } else { setProbe({ lo, hi, best }); setSq((lo + hi) >> 1); }
    });
    return () => cancelAnimationFrame(id);
  }, [sq, probe]);

  const tiles = [...groups].sort((a, b) => {
    const pa = a[1].reduce((m, x) => Math.min(m, SEV[tone(x.health)]), 9);
    const pb = b[1].reduce((m, x) => Math.min(m, SEV[tone(x.health)]), 9);
    return pa - pb || b[1].length - a[1].length;
  });

  return (
    <div className={"wbb " + st} style={{ ["--sq" as string]: sq + "px" }}>
      <section className={"wbb-hero " + st}>
        <div className="wbb-h-top">
          <span className="wbb-dot" />
          <b>{st === "ok" ? t("Сеть в норме") : st === "warn" ? t("Нужно внимание") : t("Авария")}</b>
        </div>
        <div className="wbb-pct num">{pct.toFixed(1).replace(".", ",")}<small>%</small></div>
        <div className="wbb-h-sub">{ok} {t("из")} {active.length} {t("узлов в норме")}</div>
        <div className="wbb-h-cnt">
          <span className="ok"><b className="num">{ok}</b>{t("норма")}</span>
          <span className="warn"><b className="num">{probs.length - down}</b>{t("внимание")}</span>
          <span className="down"><b className="num">{down}</b>{t("нет связи")}</span>
        </div>
        <div className="wbb-plist">
          {probs.length === 0 && <div className="wbb-calm">{t("Все узлы отвечают в пределах порогов")}</div>}
          {probs.slice(0, 8).map((s, i) => (
            <button key={s.id} className={"wbb-p " + tone(s.health)} style={{ animationDelay: `${i * 70}ms` }} onClick={() => onOpen(s.id)}>
              <i />
              <span className="wbb-pn"><b>{s.name}</b><small>{problemText(s)}</small></span>
              <span className="wbb-pd num">{dur(now - s.stateSince)}</span>
            </button>
          ))}
          {probs.length > 8 && <div className="wbb-more">{t("и ещё")} {probs.length - 8}</div>}
        </div>
      </section>

      <div className="wbb-tiles" ref={boxRef}>
        {tiles.map(([g, list]) => {
          const bad = list.filter((x) => isProblem(x.health));
          const worst = bad.reduce<Tone>((a, x) => (SEV[tone(x.health)] < SEV[a] ? tone(x.health) : a), "ok");
          const cls = worst === "down" || worst === "dep" ? "down" : worst === "bad" || worst === "warn" ? "warn" : "ok";
          const rtts = list.map((x) => x.lastRtt ?? x.avgRtt).filter((x): x is number => x != null);
          const avg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
          const cols = Math.max(2, Math.min(10, Math.ceil(Math.sqrt(list.length * 1.5))));
          return (
            <section key={g} className={"wbb-tile " + cls} style={{ ["--cols" as string]: cols, flexGrow: cols }}>
              <TileSpark v={groupSpark(list)} cls={cls} />
              <header>
                <b>{g}</b>
                <span className="num">{list.length - bad.length}/{list.length}</span>
                {cls === "down" && <em>{t("нет связи")}</em>}
                <span className="wbb-avg num">{avg == null ? "—" : `${fmtMs(avg, avg < 10 ? 1 : 0)} мс`}</span>
              </header>
              <div className="wbb-sq">
                {list.map((x) => {
                  const tn = tone(x.health);
                  const r = x.lastRtt;
                  return (
                    <button key={x.id} className={"wbb-n " + tn} style={tn === "ok" ? { ["--h" as string]: okHue(x) } : undefined}
                      title={`${x.name} · ${x.host}\n${isProblem(x.health) ? problemText(x) : t("в норме")} · ${r == null ? t("нет ответа") : fmtMs(r, 1) + " мс"} · ${t("потери")} ${fmtPct(x.lossPct)}%`}
                      onClick={() => onOpen(x.id)}>
                      {sq >= 40 && <span className="num">{r == null ? "✕" : r < 10 ? r.toFixed(1) : Math.round(r)}</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ «Обзор» */

/** Дуговой датчик 240°: деления, дуга значения с градиентом, стрелка. */
function Gauge({ value, max, label, unit, tone: tn, digits = 1, big, min0 = "0", maxLabel, mark, markLabel }: { value: number | null; max: number; label?: string; unit: string; tone: "ok" | "warn" | "down"; digits?: number; big?: boolean; min0?: string; maxLabel?: string; mark?: number; markLabel?: string }) {
  const id = useMemo(() => "g" + Math.random().toString(36).slice(2, 8), []);
  const r = 80, cx = 100, cy = 100, a0 = 150, sweep = 240;
  const f = value == null ? 0 : Math.max(0, Math.min(1, value / max));
  const pt = (deg: number, rr = r) => [cx + rr * Math.cos((deg * Math.PI) / 180), cy + rr * Math.sin((deg * Math.PI) / 180)];
  const arc = (from: number, to: number) => {
    const [x1, y1] = pt(from), [x2, y2] = pt(to);
    return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
  };
  const end = a0 + sweep * Math.max(0.002, f);
  const [nx, ny] = pt(end, r + 8), [nx2, ny2] = pt(end, r - 16);
  const ticks = Array.from({ length: 41 }, (_, i) => a0 + (sweep * i) / 40);
  const [whole, frac] = value == null ? ["—", ""] : value.toFixed(digits).split(".");
  return (
    <div className={"wo-gwrap" + (big ? " big" : "")}>
    <div className={"wo-gauge " + tn + (big ? " big" : "")}>
      <svg viewBox="-10 -16 220 182" aria-hidden>
        <defs>
          <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="var(--g1)" stopOpacity=".15" />
            <stop offset="1" stopColor="var(--g1)" />
          </linearGradient>
        </defs>
        {ticks.map((d, i) => {
          const [x1, y1] = pt(d, r + 13), [x2, y2] = pt(d, r + (i % 5 ? 17 : 21));
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={d <= end ? "tk on" : "tk"} />;
        })}
        <path d={arc(a0, a0 + sweep)} className="bg" />
        <path d={arc(a0, end)} stroke={`url(#${id})`} className="val" />
        {mark != null && (() => {
          const md = a0 + sweep * Math.max(0, Math.min(1, mark / max));
          const [m1x, m1y] = pt(md, r - 9), [m2x, m2y] = pt(md, r + 24), [lx, ly] = pt(md, r + 34);
          return <g className="mark"><line x1={m1x} y1={m1y} x2={m2x} y2={m2y} /><text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle">{markLabel}</text></g>;
        })()}
        {(() => { const [sx, sy] = pt(a0, r + 2), [ex, ey] = pt(a0 + sweep, r + 2); return <><text x={sx + 4} y={sy + 20} textAnchor="middle" className="sc">{min0}</text><text x={ex - 4} y={ey + 20} textAnchor="middle" className="sc">{maxLabel ?? String(max)}</text></>; })()}
        <line x1={nx2} y1={ny2} x2={nx} y2={ny} className="needle" />
        <circle cx={nx} cy={ny} r="3.2" className="tip" />
      </svg>
      <div className="wo-gv">
        <b className="num">{whole}{frac && <span>,{frac}</span>}<small>{unit}</small></b>
      </div>
    </div>
    {label && <em className="wo-glabel">{label}</em>}
    </div>
  );
}

function AreaLine({ v, th }: { v: (number | null)[]; th: number | null }) {
  const w = 400, h = 150;
  const vals = v.filter((x): x is number => x != null);
  if (vals.length < 3) return <div className="wo-nodata">{t("Копим историю…")}</div>;
  const max = Math.max(...vals, th ?? 0) * 1.15 || 1;
  const x = (i: number) => (i / (v.length - 1)) * w;
  const y = (n: number) => h - 6 - (n / max) * (h - 14);
  let d = "";
  v.forEach((n, i) => { if (n == null) return; d += (d ? "L" : "M") + x(i).toFixed(1) + "," + y(n).toFixed(1); });
  const lastI = v.map((n, i) => (n == null ? -1 : i)).filter((i) => i >= 0).pop() ?? 0;
  const grid = [0.25, 0.5, 0.75].map((k) => h - 6 - k * (h - 14));
  return (
    <svg className="wo-line" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="woA" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--g1)" stopOpacity=".28" /><stop offset="1" stopColor="var(--g1)" stopOpacity="0" /></linearGradient>
      </defs>
      {grid.map((g, i) => <line key={i} x1="0" x2={w} y1={g} y2={g} className="gr" />)}
      {th != null && th < max && <line x1="0" x2={w} y1={y(th)} y2={y(th)} className="th" />}
      <path d={`${d} L${x(lastI)},${h} L0,${h} Z`} fill="url(#woA)" />
      <path d={d} className="ln" />
      <circle cx={x(lastI)} cy={y(v[lastI] as number)} r="4" className="dot" />
    </svg>
  );
}

/**
 * «Обзор»: тёмная приборная панель — датчики доступности, задержки и потерь,
 * график задержки сети за 2 часа и точечная матрица: точка на каждый узел.
 */
export function WbOverview({ active, groups, now, onOpen }: { active: TargetSummary[]; groups: WallGroup[]; now: number; onOpen: (id: string) => void }) {
  const [lanes, setLanes] = useState<Record<string, TimelinePoint[]>>({});
  const [today, setToday] = useState<number | null>(null);
  const [yday, setYday] = useState<number | null>(null);
  const ids = useMemo(() => active.map((x) => x.id).sort().join(","), [active]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const to = Date.now();
      if (ids) api.timelines(ids.split(","), to - 2 * 3600e3, to, 60).then((d) => alive && setLanes(d)).catch(() => {});
      const d0 = new Date(); d0.setHours(0, 0, 0, 0);
      const up = (rows: { checks: number; lost: number }[]) => { const c = rows.reduce((a, r) => a + r.checks, 0); return c ? 100 - (rows.reduce((a, r) => a + r.lost, 0) * 100) / c : null; };
      api.report(d0.getTime(), to).then((r) => alive && setToday(up(r))).catch(() => {});
      api.report(d0.getTime() - 86400e3, d0.getTime()).then((r) => alive && setYday(up(r))).catch(() => {});
    };
    load();
    const h = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(h); };
  }, [ids]);

  const ok = active.filter((x) => x.health === "ok").length;
  const probs = active.filter((x) => isProblem(x.health)).sort((a, b) => SEV[tone(a.health)] - SEV[tone(b.health)] || a.stateSince - b.stateSince);
  const down = probs.filter((x) => tone(x.health) === "down" || tone(x.health) === "dep").length;
  const warn = probs.length - down;
  const paused = active.filter((x) => x.health === "unknown" || x.health === "paused").length;
  const okPct = active.length ? (ok * 100) / active.length : 100;
  const rtts = active.map((x) => x.avgRtt).filter((x): x is number => x != null).sort((a, b) => a - b);
  const median = rtts.length ? rtts[Math.floor(rtts.length / 2)] : null;
  const ths = active.filter((x) => x.kind !== "http").map((x) => x.thresholds.warnMs).sort((a, b) => a - b);
  const thMed = ths.length ? ths[Math.floor(ths.length / 2)] : 50;
  const loss = active.length ? active.reduce((a, x) => a + x.lossPct, 0) / active.length : 0;
  const lts = active.map((x) => x.thresholds.warnLoss).sort((a, b) => a - b);
  const lossTh = lts.length ? lts[Math.floor(lts.length / 2)] : 5;

  // Задержка сети: медиана по узлам в каждой точке за 2 часа.
  const series = useMemo(() => {
    const n = 60;
    const out: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      const v: number[] = [];
      for (const s of active) { if (s.kind === "http") continue; const p = lanes[s.id]?.[i]; if (p?.avg != null) v.push(p.avg); }
      v.sort((a, b) => a - b);
      out.push(v.length ? v[Math.floor(v.length / 2)] : null);
    }
    return out;
  }, [lanes, active]);
  const lastSeries = [...series].reverse().find((x) => x != null) ?? null;
  const firstSeries = series.find((x) => x != null) ?? null;

  // Гистограмма: задержка каждого узла, отсортировано по группам.
  const bars = active.filter((x) => x.kind !== "http");
  const bmax = Math.max(1, ...bars.map((x) => x.lastRtt ?? x.avgRtt ?? 0));
  const tnDelta = today != null && yday != null ? today - yday : null;
  const gTone = (v: number, w: number, d: number): "ok" | "warn" | "down" => (v >= w ? "ok" : v >= d ? "warn" : "down");

  return (
    <div className="wo">
      <section className="wo-card wo-hero">
        <header><span>{t("Узлы под наблюдением")}</span><i className={"wo-led " + (down ? "down" : warn ? "warn" : "ok")} /></header>
        <div className="wo-big num">{active.length}</div>
        <div className="wo-sub"><span className={down ? "c-down" : warn ? "c-warn" : "wo-acc"}>{probs.length ? `${probs.length} ${t("не в норме")}` : t("все отвечают")}</span> · {t("задержка каждого узла")}</div>
        <div className="wo-bars">
          {bars.map((x) => {
            const v = x.lastRtt ?? x.avgRtt;
            const tn = tone(x.health);
            return <i key={x.id} className={tn} style={{ height: `${tn === "down" || tn === "dep" || v == null ? 100 : 6 + 94 * Math.sqrt(v / bmax)}%` }} title={`${x.name} — ${v == null ? "нет ответа" : fmtMs(v, 1) + " мс"}`} onClick={() => onOpen(x.id)} />;
          })}
        </div>
        <div className="wo-hero-g">
          <Gauge value={today} max={100} unit="%" tone={today == null ? "ok" : gTone(today, 99.5, 98)} digits={2} big min0="0%" maxLabel="100%" label={t("доступность сегодня, доля успешных проверок")} />
          {tnDelta != null && (Math.abs(tnDelta) < 0.005
            ? <div className="wo-delta eq">{t("как вчера")}</div>
            : <div className={"wo-delta " + (tnDelta > 0 ? "up" : "dn")}>{tnDelta > 0 ? "▲" : "▼"} {Math.abs(tnDelta).toFixed(2)} {t("п.п. ко вчера")}</div>)}
        </div>
      </section>

      <section className="wo-card wo-g">
        <header><span>{t("Узлов в норме")}</span><small className="num">{ok} {t("из")} {active.length}</small></header>
        <div className="wo-mini"><span><b className="num">{ok}</b>{t("норма")}</span><span><b className="num">{warn}</b>{t("внимание")}</span><span><b className="num">{down}</b>{t("нет связи")}</span></div>
        <Gauge value={okPct} max={100} unit="%" tone={gTone(okPct, 98, 90)} digits={1} maxLabel="100%" min0="0%" label={t("доля узлов без замечаний")} />
      </section>
      <section className="wo-card wo-g">
        <header><span>{t("Типичная задержка")}</span><small className="num">{t("порог")} {thMed} {t("мс")}</small></header>
        <div className="wo-mini"><span><b className="num">{rtts.length ? fmtMs(rtts[0], 1) : "—"}</b>{t("мс у лучшего узла")}</span><span><b className="num">{rtts.length ? fmtMs(rtts[rtts.length - 1], 0) : "—"}</b>{t("мс у худшего")}</span></div>
        <Gauge value={median} max={thMed * 1.5} unit=" мс" tone={median == null ? "ok" : median <= thMed * 0.7 ? "ok" : median <= thMed ? "warn" : "down"} digits={median != null && median < 10 ? 1 : 0}
          maxLabel={`${Math.round(thMed * 1.5)}`} mark={thMed} markLabel={t("порог")} label={t("половина узлов отвечает быстрее")} />
      </section>
      <section className="wo-card wo-g">
        <header><span>{t("Потери пакетов")}</span><small className="num">{t("порог")} {lossTh}%</small></header>
        <div className="wo-mini"><span><b className="num">{active.filter((x) => x.lossPct > 0).length}</b>{t("узлов с потерями")}</span><span><b className="num">{active.filter((x) => x.lossPct >= x.thresholds.badLoss).length}</b>{t("выше порога")}</span></div>
        <Gauge value={loss} max={lossTh * 2} unit="%" tone={loss < lossTh / 2 ? "ok" : loss < lossTh ? "warn" : "down"} digits={2}
          maxLabel={`${lossTh * 2}%`} min0="0%" mark={lossTh} markLabel={t("порог")} label={t("в среднем по всем узлам")} />
      </section>

      <section className="wo-card wo-chart">
        <header><span>{t("Типичная задержка за 2 часа")}</span><small className="num">{t("порог")} {thMed} {t("мс")}</small></header>
        <div className="wo-chart-v num">{lastSeries == null ? "—" : fmtMs(lastSeries, 1)}<small> мс</small>
          {lastSeries != null && firstSeries != null && <em className={lastSeries > firstSeries * 1.15 ? "c-warn" : "wo-acc"}>{lastSeries > firstSeries * 1.15 ? "▲ " + t("растёт") : t("ровно")}</em>}
        </div>
        <AreaLine v={series} th={thMed} />
        <div className="wo-axis num"><span>−2 ч</span><span>−1,5</span><span>−1 ч</span><span>−30 мин</span><span>{t("сейчас")}</span></div>
      </section>

      <section className="wo-card wo-dots">
        <header><span>{t("Состояние узлов")}</span><small>{t("точка — узел")}</small></header>
        <div className="wo-dm">
          {groups.map(([g, list]) => {
            const per = Math.max(6, Math.ceil(list.length / Math.ceil(list.length / 10)));
            const cols = Math.ceil(list.length / per);
            return (
              <div key={g} className="wo-dg" title={g} style={{ flexGrow: cols }}>
                <div className="wo-dc" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${per}, 1fr)` }}>
                  {list.map((x) => <i key={x.id} className={tone(x.health)} title={`${x.name} — ${isProblem(x.health) ? problemText(x) : t("в норме")}`} onClick={() => onOpen(x.id)} />)}
                </div>
                <span>{g}</span>
              </div>
            );
          })}
        </div>
        <footer className="wo-legend num">
          <span><b>{String(ok).padStart(2, "0")}</b>{t("норма")}<i className="ok" /></span>
          <span><b>{String(warn).padStart(2, "0")}</b>{t("внимание")}<i className="warn" /></span>
          <span><b>{String(down).padStart(2, "0")}</b>{t("нет связи")}<i className="down" /></span>
          <span><b>{String(paused).padStart(2, "0")}</b>{t("нет данных")}<i className="dim" /></span>
        </footer>
      </section>

      <section className="wo-card wo-probs">
        <header><span>{t("Требуют внимания")}</span><small className="num">{probs.length}</small></header>
        {probs.length === 0 ? <div className="wo-calm wo-acc">{t("Проблем нет — все узлы в пределах порогов")}</div> : (
          <div className="wo-pl">
            {probs.slice(0, 6).map((s) => (
              <button key={s.id} className={"wo-p " + tone(s.health)} onClick={() => onOpen(s.id)}>
                <i /><b>{s.name}</b><span>{problemText(s)}</span><em className="num">{dur(now - s.stateSince)}</em>
              </button>
            ))}
            {probs.length > 6 && <div className="wo-more">+{probs.length - 6}</div>}
          </div>
        )}
      </section>
    </div>
  );
}
