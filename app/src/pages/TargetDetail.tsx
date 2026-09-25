import { t } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Diagnosis, EventRecord, HeatCell, HopSeries, Target, TargetSummary, TimelinePoint, TraceView } from "../types";
import { MultiTimeline, SERIES_COLORS } from "../components/MultiTimeline";
import { Heatmap } from "../components/Heatmap";
import { HEALTH_LABEL, KIND_LABEL } from "../types";
import { fmtDateTime, fmtMs, fmtPct, fmtTime, latencyClass, lossClass } from "../format";
import { Timeline } from "../components/Timeline";
import { LatencyBar } from "../components/LatencyBar";
import { RouteBadge, Dot, Icon, MutedBadge } from "../components/ui";
import { ask } from "../components/Dialogs";
import { DiagnosisCard } from "../components/DiagnosisCard";

const RANGES: { l: string; ms: number }[] = [
  { l: "5 мин", ms: 5 * 60e3 },
  { l: "10 мин", ms: 10 * 60e3 },
  { l: "30 мин", ms: 30 * 60e3 },
  { l: "1 ч", ms: 3600e3 },
  { l: "6 ч", ms: 6 * 3600e3 },
  { l: "24 ч", ms: 24 * 3600e3 },
  { l: "7 дн", ms: 7 * 86400e3 },
  { l: "30 дн", ms: 30 * 86400e3 },
];

interface Props {
  id: string;
  summary: TargetSummary | undefined;
  onBack: () => void;
  onEdit: (t: Target) => void;
  onDeleted: () => void;
  toast: (msg: string, kind?: string) => void;
  /** Момент события: показать график ±5 минут вокруг него. */
  at?: number;
  onToggleMute: () => void;
}

const AROUND_MS = 5 * 60e3;

export function TargetDetail({ id, summary: s, onBack, onEdit, onDeleted, toast, at, onToggleMute }: Props) {
  const [range, setRange] = useState(() => {
    if (at) return 2 * AROUND_MS;
    try { return Number(localStorage.getItem("np.range")) || 10 * 60e3; } catch { return 10 * 60e3; }
  });
  const [end, setEnd] = useState<number | null>(() => (at && at + AROUND_MS < Date.now() ? at + AROUND_MS : null)); // null = Live
  const [now, setNow] = useState(Date.now());
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [ttl, setTtl] = useState<number | null>(null);
  const [trace, setTrace] = useState<TraceView | null>(null);
  const [tlFinal, setTlFinal] = useState<TimelinePoint[]>([]);
  const [tlHop, setTlHop] = useState<TimelinePoint[]>([]);
  const [uptime, setUptime] = useState<{ d1: number | null; d7: number | null }>({ d1: null, d7: null });
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [hopSeries, setHopSeries] = useState<HopSeries[]>([]);
  const [hiddenHops, setHiddenHops] = useState<Set<number>>(new Set());
  const [showHops, setShowHops] = useState(() => { try { return localStorage.getItem("np.showHops") !== "0"; } catch { return true; } });
  const [heat, setHeat] = useState<HeatCell[] | null>(null);
  const [heatDays, setHeatDays] = useState(7);
  const [heatMetric, setHeatMetric] = useState<"avg" | "loss">("loss");
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [diagTick, setDiagTick] = useState(0);
  // Номер последнего запроса: ответ устаревшего запроса не должен перезаписывать свежий.
  const reqId = useRef(0);
  const loadId = useRef(0);

  const to = end ?? now;
  const from = to - range;
  const live = end == null;
  // Выделенный участок приближает графики: показываем данные только за него.
  const [vFrom, vTo] = focus ?? [from, to];

  useEffect(() => { setTrace(null); setTlFinal([]); setTlHop([]); setTtl(null); setFocus(null); setDiag(null); setDiagError(null); setDiagBusy(false); }, [id]);

  // Анализ считается по тому же окну, что показывают графики и таблица маршрута.
  const diagKey = `${vFrom}-${vTo}`;
  const runDiag = useCallback(() => {
    const my = ++reqId.current;
    setDiagBusy(true);
    api
      .diagnosis(id, vFrom, vTo)
      .then((d) => {
        if (my !== reqId.current) return;
        setDiag(d);
        setDiagError(null);
      })
      .catch((e) => {
        if (my !== reqId.current) return;
        setDiagError(String(e));
      })
      .finally(() => {
        if (my === reqId.current) setDiagBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, diagKey]);

  useEffect(() => {
    runDiag();
    // Автоматический пересчёт — только пока смотрим «сейчас» и не выделен участок.
    const t = live && !focus ? setInterval(runDiag, 15000) : undefined;
    return () => { if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runDiag, diagTick, live, focus]);

  const diagTtls = useMemo(() => new Set((diag?.findings ?? []).filter((f) => f.ttl != null && (f.level === "crit" || f.level === "warn")).map((f) => f.ttl!)), [diag]);

  /** Переход к событию: окно ±5 минут вокруг него. */
  const jumpTo = (ts: number) => {
    setFocus(null);
    setRange(2 * AROUND_MS);
    setNow(Date.now());
    setEnd(ts + AROUND_MS < Date.now() ? ts + AROUND_MS : null);
  };

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), range <= 30 * 60e3 ? 2000 : 10000);
    return () => clearInterval(t);
  }, [live, range]);

  const points = Math.min(900, Math.max(120, Math.round(window.innerWidth / 2)));

  const load = useCallback(async () => {
    const [f0, f1] = focus ?? [from, to];
    const my = ++loadId.current;
    try {
      const [tr, tf] = await Promise.all([api.trace(id, f0, f1), api.timeline(id, null, f0, f1, points)]);
      if (my !== loadId.current) return;
      setTrace(tr);
      setTlFinal(tf);
      if (ttl != null) {
        const hop = await api.timeline(id, ttl, f0, f1, points);
        if (my === loadId.current) setTlHop(hop);
      }
    } catch (e) {
      console.warn(e);
    }
  }, [id, from, to, focus, ttl, points]);

  useEffect(() => { load(); }, [load]);

  // Задержка по хопам во времени (только трассировка, по сырым данным).
  const kind = s?.kind;
  useEffect(() => {
    if (kind !== "trace" || !showHops) return;
    const [f0, f1] = focus ?? [from, to];
    let alive = true;
    api.hopTimelines(id, f0, f1, Math.min(400, points)).then((r) => alive && setHopSeries(r)).catch(() => {});
    return () => { alive = false; };
  }, [id, kind, from, to, focus, points, showHops]);

  useEffect(() => {
    const now = Date.now();
    setHeat(null);
    let alive = true;
    api.heatmap(id, now - heatDays * 86400e3, now).then((r) => alive && setHeat(r)).catch(() => alive && setHeat([]));
    return () => { alive = false; };
  }, [id, heatDays]);

  useEffect(() => {
    const f = () => {
      Promise.all([api.uptime(id, 24), api.uptime(id, 24 * 7)]).then(([d1, d7]) => setUptime({ d1, d7 })).catch(() => {});
      api.events(50, id).then(setEvents).catch(() => {});
    };
    f();
    const t = setInterval(f, 15000);
    return () => clearInterval(t);
  }, [id]);

  const target = useCallback(async () => (await api.listTargets()).find((t) => t.id === id), [id]);

  const hopScale = useMemo(() => {
    if (!trace || !s) return 100;
    const vals = trace.hops.map((h) => h.avg ?? 0);
    const m = Math.max(Number.isFinite(s.thresholds.critMs) ? s.thresholds.critMs * 1.2 : 1, ...vals.map((v) => v * 1.25));
    return m;
  }, [trace, s]);

  if (!s) {
    return <div className="empty">{t("Цель не найдена")} <button className="btn" onClick={onBack}>{t("Назад")}</button></div>;
  }

  const th = s.thresholds;
  // Смена маршрута имеет смысл только у трассировки; у Ping показываем периоды недоступности и прочее.
  const shownEvents = s.kind === "trace" ? events : events.filter((e) => e.kind !== "route");
  const fin = trace?.finalStats;
  const isTrace = s.kind === "trace";
  const selectedHop = trace?.hops.find((h) => h.ttl === ttl);

  const del = async () => {
    if (!(await ask({ title: `Удалить «${s.name}»?`, message: "Цель и вся её история будут удалены без возможности восстановления.", confirm: "Удалить", danger: true }))) return;
    await api.deleteTarget(id);
    toast(`«${s.name}» удалена`);
    onDeleted();
  };

  const exportCsv = async () => {
    const [f0, f1] = focus ?? [from, to];
    try {
      const p = await api.exportCsv(id, s.name, f0, f1);
      if (p) toast(`CSV сохранён: ${p}`, "ok");
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const shift = (dir: number) => {
    const base = end ?? Date.now();
    const next = base + dir * range;
    setFocus(null);
    setEnd(next >= Date.now() ? null : next);
  };

  return (
    <>
      <div className="toolbar">
        <button className="btn ghost icon-btn" onClick={onBack} title={t("К списку")}><Icon name="back" /></button>
        <div className="detail-head" style={{ flex: 1 }}>
          <Dot h={s.health} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <b style={{ fontSize: 15 }}>{s.name}</b>
              <span className="kind">{KIND_LABEL[s.kind]}</span>
              <RouteBadge at={s.routeChangedAt} text={s.routeChange} />
              <MutedBadge on={s.alertsEnabled} />
              <span className={"pill " + s.health}>{HEALTH_LABEL[s.health]}</span>
              {(s.health === "down" || s.cause) && (s.cause ?? s.lastError) && <span className={s.health === "down" || s.health === "crit" ? "err" : "err warn"} title={s.cause ?? s.lastError ?? ""} style={{ maxWidth: 420 }}>{s.cause ?? s.lastError}</span>}
              {s.health === "dependent" && <span className="c-muted" style={{ fontSize: 12 }}>недоступен из-за «{s.blockedBy}» — уведомления не отправляются</span>}
            </div>
            <div className="host">{s.host}{s.resolvedIp && s.resolvedIp !== s.host ? ` → ${s.resolvedIp}` : ""} · {s.group}</div>
          </div>
        </div>
        <button className={"btn" + (s.alertsEnabled ? "" : " muted-on")} onClick={onToggleMute} title={s.alertsEnabled ? "Режим тишины: события пишутся в журнал, но без уведомлений" : "Снова присылать уведомления"}>
          <Icon name={s.alertsEnabled ? "bell" : "bellOff"} size={13} />{t(s.alertsEnabled ? "Уведомления" : "Тишина")}
        </button>
        <button className="btn" onClick={() => api.setEnabled(id, !s.enabled)}><Icon name={s.enabled ? "pause" : "play"} size={13} />{t(s.enabled ? "Пауза" : "Запустить")}</button>
        <button className="btn" onClick={async () => { const t = await target(); if (t) onEdit(t); }}><Icon name="edit" size={13} />{t("Настроить")}</button>
        <button className="btn" onClick={exportCsv}><Icon name="download" size={13} />CSV</button>
        <button className="btn danger icon-btn" onClick={del} title={t("Удалить")}><Icon name="trash" size={14} /></button>
      </div>

      <div className="kpis">
        <Kpi l={t("Текущая")} v={fmtMs(s.lastRtt)} u="мс" c={latencyClass(s.lastRtt, th)} />
        <Kpi l={t(focus ? "Средняя (выделено)" : "Средняя")} v={fmtMs(fin?.avg ?? null)} u="мс" c={fin?.avg == null ? "" : latencyClass(fin.avg, th)} />
        <Kpi l={t("Мин / Макс")} v={`${fmtMs(fin?.min ?? null)} / ${fmtMs(fin?.max ?? null)}`} />
        <Kpi l="Jitter" v={fmtMs(fin?.jitter ?? null, 1)} u="мс" c={fin?.jitter == null ? "" : th.jitterCrit > 0 && fin.jitter > th.jitterCrit ? "c-down" : th.jitterWarn > 0 && fin.jitter > th.jitterWarn ? "c-warn" : ""} />
        <Kpi l={t("Потери")} v={fmtPct(fin?.lossPct ?? 0)} u="%" c={lossClass(fin?.lossPct ?? 0, th)} />
        {s.kind !== "http" && s.kind !== "dns" && <Kpi l="MOS (VoIP)" v={trace?.mos != null ? trace.mos.toFixed(2) : "—"} c={trace?.mos == null ? "" : th.mosCrit > 0 && trace.mos < th.mosCrit ? "c-down" : th.mosWarn > 0 && trace.mos < th.mosWarn ? "c-warn" : trace.mos >= 4 ? "c-ok" : trace.mos >= 3.5 ? "c-warn" : "c-down"} />}
        {s.kind === "http" && <Kpi l={t("HTTP-код")} v={s.statusCode ? String(s.statusCode) : "—"} c={s.statusCode && s.statusCode < 400 ? "c-ok" : "c-down"} />}
        {s.kind === "http" && <Kpi l={t("SSL истекает")} v={s.certDays == null ? "—" : String(s.certDays)} u="дн." c={s.certDays == null ? "" : s.certDays < 7 ? "c-down" : s.certDays < 21 ? "c-warn" : "c-ok"} />}
        <Kpi l={t("Аптайм 24 ч")} v={uptime.d1 == null ? "—" : uptime.d1.toFixed(2)} u="%" c={uptime.d1 == null ? "" : uptime.d1 >= 99.5 ? "c-ok" : uptime.d1 >= 98 ? "c-warn" : "c-down"} />
        <Kpi l={t("Аптайм 7 дн")} v={uptime.d7 == null ? "—" : uptime.d7.toFixed(2)} u="%" />
      </div>

      <div className="toolbar" style={{ borderBottom: 0, paddingBottom: 0 }}>
        <div className="chips">
          {RANGES.map((r) => (
            <button key={r.ms} className={range === r.ms ? "on" : ""} onClick={() => { setRange(r.ms); setFocus(null); try { localStorage.setItem("np.range", String(r.ms)); } catch { /* */ } }}>{t(r.l)}</button>
          ))}
        </div>
        <div className="chips">
          <button onClick={() => shift(-1)} title={t("Назад во времени")}>◀</button>
          <button className={live ? "on" : ""} onClick={() => { setEnd(null); setFocus(null); }} style={live ? { color: "var(--accent)" } : undefined}>{t("● Сейчас")}</button>
          <button onClick={() => shift(1)} disabled={live} title={t("Вперёд")}>▶</button>
        </div>
        <span className="c-muted num" style={{ fontSize: 12 }}>{fmtDateTime(from)} — {live ? "сейчас" : fmtDateTime(to)}</span>
        {focus && (
          <span className="pill" style={{ color: "var(--info)", borderColor: "rgba(90,169,255,.35)" }}>
            Приближено: {fmtTime(focus[0])} – {fmtTime(focus[1])}
            <button className="btn ghost sm" style={{ height: 18, padding: "0 4px" }} onClick={() => setFocus(null)}>✕</button>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="c-muted" style={{ fontSize: 11.5 }}>{t("Выделите участок графика мышью — график приблизится к нему · двойной клик или ✕ — весь период")}</span>
      </div>

      <div className="section" style={{ paddingBottom: 0 }}>
        <DiagnosisCard hops={isTrace} d={diag} loading={diagBusy} error={diagError} frozen={!!focus} onRefresh={() => { load(); setDiagTick((x) => x + 1); }} onHop={(t) => { if (isTrace) setTtl(t); }} />
      </div>

      {isTrace && (
        <div className="section">
          <div className="section-title">
            Маршрут <span className="sub">{trace ? `${trace.hops.length} хопов · ${trace.samples} проверок${focus ? " в выделенном участке" : ""}` : "загрузка…"}</span>
            <span className="sub" style={{ marginLeft: "auto" }}>{t("клик по хопу — его график ниже")}</span>
          </div>
          <table className="grid hops">
            <thead>
              <tr>
                <th className="r" style={{ width: 40 }}>{t("Хоп")}</th>
                <th className="r">{t("Потери")}</th>
                <th>IP</th>
                <th>{t("Имя")}</th>
                <th className="r">{t("Средн.")}</th>
                <th className="r">{t("Мин")}</th>
                <th className="r">{t("Макс")}</th>
                <th className="r">{t("Тек.")}</th>
                <th className="r">Jitter</th>
                <th className="lat-cell" style={{ paddingTop: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span>{t("0 мс")}</span><span>{Math.round(hopScale / 2)}</span><span>{Math.round(hopScale)} мс</span></div>
                </th>
              </tr>
            </thead>
            <tbody>
              {trace?.hops.map((h, i) => {
                const isFinal = i === trace.hops.length - 1;
                return (
                  <tr key={h.ttl} className={(ttl === h.ttl ? "sel " : "") + (h.suspect ? "suspect" : "")} onClick={() => setTtl(ttl === h.ttl ? null : h.ttl)}>
                    <td className="r num c-muted">{h.ttl}</td>
                    <td className={"r num " + lossClass(h.lossPct, th)} title={`${h.lost} из ${h.sent}`}>{fmtPct(h.lossPct)}%</td>
                    <td className="num" style={{ userSelect: "text" }}>{h.addr ?? <span className="c-dim">* * *</span>}</td>
                    <td className="hop-name" title={h.hostname ?? ""}>{h.hostname ?? (isFinal ? s.host : "")}{h.suspect && <span className="pill down" style={{ marginLeft: 8, height: 18 }}>{t("потери начинаются здесь")}</span>}{!h.suspect && diagTtls.has(h.ttl) && <span className="pill warn" style={{ marginLeft: 8, height: 18 }}>{t("см. анализ")}</span>}</td>
                    <td className={"r num " + (h.avg == null ? "c-dim" : latencyClass(h.avg, th))}>{fmtMs(h.avg, 1)}</td>
                    <td className="r num c-muted">{fmtMs(h.min, 1)}</td>
                    <td className="r num c-muted">{fmtMs(h.max, 1)}</td>
                    <td className="r num">{h.cur == null ? <span className="c-down">✕</span> : fmtMs(h.cur, 1)}</td>
                    <td className="r num c-muted">{fmtMs(h.jitter, 1)}</td>
                    <td className="lat-cell"><LatencyBar hop={h} th={th} scaleMax={hopScale} prevAvg={i > 0 ? trace.hops[i - 1].avg : null} /></td>
                  </tr>
                );
              })}
              {fin && (
                <tr className="final" style={{ cursor: "default" }}>
                  <td colSpan={2} className="r num">{fmtPct(fin.lossPct)}%</td>
                  <td colSpan={2}>{t("Итог до цели (туда и обратно)")}</td>
                  <td className="r num">{fmtMs(fin.avg, 1)}</td>
                  <td className="r num">{fmtMs(fin.min, 1)}</td>
                  <td className="r num">{fmtMs(fin.max, 1)}</td>
                  <td className="r num">{fmtMs(fin.cur, 1)}</td>
                  <td className="r num">{fmtMs(fin.jitter, 1)}</td>
                  <td className="c-muted" style={{ fontWeight: 400, fontSize: 11.5 }}>{trace && `${fmtTime(trace.from, false)} – ${fmtTime(trace.to, false)}`}</td>
                </tr>
              )}
            </tbody>
          </table>
          {trace && trace.hops.some((h) => h.lossPct > 5 && !h.suspect) && (fin?.lossPct ?? 0) < 1 && (
            <div className="c-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
              Потери на промежуточных хопах, которые не доходят до цели, обычно означают, что маршрутизатор ограничивает ICMP-ответы. На качество связи это не влияет.
            </div>
          )}
        </div>
      )}

      <div className="section" style={{ paddingTop: isTrace ? 0 : 14 }}>
        <div className="chart-card">
          <div className="hdr">
            <span className="ttl">{s.name}</span>
            <span className="sub">{isTrace ? "конечная цель" : KIND_LABEL[s.kind]}{s.enabled ? "" : " · пауза"}</span>
            <Legend />
          </div>
          <Timeline points={tlFinal} from={vFrom} to={vTo} th={th} onFocus={setFocus} height={isTrace ? 180 : 260} />
        </div>
        {isTrace && ttl != null && (
          <div className="chart-card">
            <div className="hdr">
              <span className="ttl">Хоп {ttl}</span>
              <span className="sub">{selectedHop?.addr ?? "* * *"}{selectedHop?.hostname ? ` · ${selectedHop.hostname}` : ""}</span>
              <Legend />
              <button className="btn ghost sm" onClick={() => setTtl(null)}>✕</button>
            </div>
            <Timeline points={tlHop} from={vFrom} to={vTo} th={th} onFocus={setFocus} height={160} />
          </div>
        )}
      </div>

      {isTrace && (
        <div className="section" style={{ paddingTop: 0 }}>
          <div className="chart-card">
            <div className="hdr">
              <span className="ttl">{t("Задержка по хопам во времени")}</span>
              <span className="sub">{t("на каком участке маршрута растёт задержка")}</span>
              <span style={{ flex: 1 }} />
              <button className="btn ghost sm" onClick={() => { const v = !showHops; setShowHops(v); try { localStorage.setItem("np.showHops", v ? "1" : "0"); } catch { /* */ } }}>{showHops ? "Свернуть" : "Показать"}</button>
            </div>
            {showHops && (
              <>
                <MultiTimeline
                  series={hopSeries
                    .filter((h) => !hiddenHops.has(h.ttl) && h.points.some((p) => p.avg != null))
                    .map((h) => ({ id: String(h.ttl), label: `${h.ttl} · ${h.hostname ?? h.addr ?? "* * *"}`, color: SERIES_COLORS[(h.ttl - 1) % SERIES_COLORS.length], points: h.points }))
}
                  from={vFrom}
                  to={vTo}
                  metric="avg"
                  height={220}
                  onFocus={setFocus}
                />
                <div className="series-legend">
                  {hopSeries.filter((h) => h.points.some((p) => p.avg != null)).map((h) => (
                    <button key={h.ttl} className={hiddenHops.has(h.ttl) ? "off" : ""} title={h.addr ?? ""} onClick={() => setHiddenHops((cur) => { const n = new Set(cur); if (n.has(h.ttl)) n.delete(h.ttl); else n.add(h.ttl); return n; })}>
                      <i style={{ background: SERIES_COLORS[(h.ttl - 1) % SERIES_COLORS.length] }} /><span>{h.ttl} · {h.hostname ?? h.addr}</span>
                    </button>
                  ))}
                  {hopSeries.length > 0 && (
                    <>
                      <button onClick={() => setHiddenHops(new Set())}>{t("все")}</button>
                      <button onClick={() => setHiddenHops(new Set(hopSeries.slice(0, -1).map((h) => h.ttl)))}>{t("только цель")}</button>
                    </>
                  )}
                </div>
                {range > 72 * 3600e3 && <div className="c-muted" style={{ fontSize: 11.5, marginTop: 6 }}>Данные по хопам хранятся {""}3 суток (настройка «подробные данные»).</div>}
              </>
            )}
          </div>
        </div>
      )}

      <div className="section" style={{ paddingTop: 0 }}>
        <div className="chart-card">
          <div className="hdr">
            <span className="ttl">{t("Тепловая карта: дни × часы")}</span>
            <span className="sub">{t("в какие часы регулярно проблемы")}</span>
            <span style={{ flex: 1 }} />
            <div className="chips">
              <button className={heatMetric === "loss" ? "on" : ""} onClick={() => setHeatMetric("loss")}>{t("Потери")}</button>
              {s.kind !== "http" && <button className={heatMetric === "avg" ? "on" : ""} onClick={() => setHeatMetric("avg")}>{t("Задержка")}</button>}
            </div>
            <div className="chips">
              {[7, 14, 30].map((d) => <button key={d} className={heatDays === d ? "on" : ""} onClick={() => setHeatDays(d)}>{d} дн</button>)}
            </div>
          </div>
          {heat == null ? (
            <div className="c-muted" style={{ padding: 20 }}>{t("Загрузка…")}</div>
          ) : heat.every((c) => !c.count) ? (
            <div className="c-muted" style={{ padding: 20 }}>{t("Пока мало данных: карта строится по минутной истории и заполнится со временем.")}</div>
          ) : (
            <>
              <Heatmap cells={heat} metric={heatMetric === "avg" && s.kind === "http" ? "loss" : heatMetric} th={th} />
              <div className="hm-legend" style={{ marginTop: 8 }}>
                <span><i style={{ background: "rgba(53,224,138,0.3)" }} />{t("норма")}</span>
                <span><i style={{ background: "rgba(242,193,78,0.55)" }} />{heatMetric === "loss" ? `${t("потери")} > ${th.warnLoss}%` : `> ${th.warnMs} мс`}</span>
                {heatMetric === "avg" && <span><i style={{ background: "rgba(255,145,71,0.6)" }} />{`> ${th.badMs} мс`}</span>}
                <span><i style={{ background: "rgba(255,77,94,0.75)" }} />{heatMetric === "loss" ? `${t("потери")} > ${th.badLoss}%` : `> ${th.critMs} мс`}</span>
                <span><i style={{ background: "rgba(255,255,255,0.05)" }} />{t("нет данных")}</span>
                <span style={{ marginLeft: "auto" }}>{t("дни и часы по местному времени · наведите на ячейку")}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="section" style={{ paddingTop: 0 }}>
        <div className="section-title">{t("События цели")} <span className="sub">{shownEvents.length ? "" : "пока нет"}</span></div>
        {shownEvents.map((e) => (
          <div key={e.id} className="ev ev-click" style={{ gridTemplateColumns: "150px 1fr auto" }} onClick={() => jumpTo(e.ts)} title={t("Показать на графике ±5 минут")}>
            <span className="ts">{fmtDateTime(e.ts)}</span>
            <span className="msg">{e.message}</span>
            <span className="tg">{t("на графике →")}</span>
          </div>
        ))}
      </div>
      <div style={{ height: 20 }} />
    </>
  );
}

function Kpi({ l, v, u, c }: { l: string; v: string; u?: string; c?: string }) {
  return (
    <div className="kpi">
      <div className="l">{l}</div>
      <div className={"v " + (c ?? "")}>{v}{u && v !== "—" && <small>{u}</small>}</div>
    </div>
  );
}

function Legend() {
  return (
    <span className="legend">
      <span><i style={{ background: "#e9eef3" }} />{t("средняя")}</span>
      <span><i style={{ background: "rgba(200,215,230,.35)", height: 8 }} />{t("мин–макс")}</span>
      <span><i style={{ background: "var(--down)" }} />{t("потери, %")}</span>
    </span>
  );
}
