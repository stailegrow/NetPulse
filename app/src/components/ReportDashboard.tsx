import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import type { DowntimeProfile, Incident, Operator, ReportRow } from "../types";
import { fmtDuration } from "../pages/Reports";

interface Props {
  rows: ReportRow[];
  from: number;
  to: number;
  group: string | null;
  onGroup: (g: string | null) => void;
  onOpen: (id: string, at?: number) => void;
}

const DAY = 86400e3;

/** Доступность, взвешенная по числу проверок. */
function uptimeOf(rows: ReportRow[]) {
  const checks = rows.reduce((a, r) => a + r.checks, 0);
  const lost = rows.reduce((a, r) => a + r.lost, 0);
  return checks ? 100 - (lost * 100) / checks : null;
}

function Delta({ cur, prev, better, fmt }: { cur: number | null; prev: number | null; better: "up" | "down"; fmt: (v: number) => string }) {
  if (cur == null || prev == null) return <span className="rd-delta c-muted">{t("нет данных за прошлый период")}</span>;
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return <span className="rd-delta c-muted">{t("как в прошлом периоде")}</span>;
  const good = better === "up" ? d > 0 : d < 0;
  return <span className={"rd-delta " + (good ? "c-ok" : "c-down")}>{d > 0 ? "▲" : "▼"} {fmt(Math.abs(d))} <span className="c-muted">{t("к прошлому")}</span></span>;
}

export function ReportDashboard({ rows, from, to, group, onGroup, onOpen }: Props) {
  const span = to - from;
  const [prev, setPrev] = useState<ReportRow[] | null>(null);
  const [prof, setProf] = useState<DowntimeProfile[]>([]);
  const [profPrev, setProfPrev] = useState<DowntimeProfile[]>([]);
  const [inc, setInc] = useState<Incident[]>([]);
  const [incPrev, setIncPrev] = useState<Incident[]>([]);
  const [ops, setOps] = useState<Operator[]>([]);
  const [sla, setSla] = useState(99.9);

  useEffect(() => {
    let alive = true;
    setPrev(null);
    api.report(from - span, from).then((r) => alive && setPrev(r)).catch(() => alive && setPrev([]));
    api.downtimeProfiles(from, to).then((p) => alive && setProf(p)).catch(() => {});
    api.downtimeProfiles(from - span, from).then((p) => alive && setProfPrev(p)).catch(() => {});
    api.incidents(from, to, 5000).then((l) => alive && setInc(l)).catch(() => {});
    api.incidents(from - span, from, 5000).then((l) => alive && setIncPrev(l)).catch(() => {});
    api.operators().then((o) => alive && setOps(o)).catch(() => {});
    api.settings().then((s) => alive && setSla(s.slaTarget || 99.9)).catch(() => {});
    return () => { alive = false; };
  }, [from, to, span]);

  const inGroup = (g: string) => !group || g === group;
  const cur = rows.filter((r) => r.checks > 0 && inGroup(r.group));
  const old = (prev ?? []).filter((r) => r.checks > 0 && inGroup(r.group));
  const ids = new Set(cur.map((r) => r.id));
  const incIn = (l: Incident[]) => l.filter((i) => i.targets.some((x) => ids.has(x.id)) && i.opened >= from - span);
  const incCur = incIn(inc).filter((i) => i.opened >= from);
  const incOld = incIn(incPrev).filter((i) => i.opened < from);
  const mttr = (l: Incident[]) => { const c = l.filter((i) => i.closed); return c.length ? c.reduce((a, i) => a + (i.closed! - i.opened), 0) / c.length : null; };

  const k = {
    up: uptimeOf(cur), upOld: prev ? uptimeOf(old) : null,
    down: cur.reduce((a, r) => a + r.downtimeMs, 0), downOld: prev ? old.reduce((a, r) => a + r.downtimeMs, 0) : null,
    inc: incCur.length, incOld: prev ? incOld.length : null,
    mttr: mttr(incCur), mttrOld: mttr(incOld),
  };

  // Доступность по группам.
  const groups = useMemo(() => {
    const m = new Map<string, ReportRow[]>();
    for (const r of rows.filter((x) => x.checks > 0)) { if (!m.has(r.group)) m.set(r.group, []); m.get(r.group)!.push(r); }
    return [...m.entries()].map(([name, l]) => ({ name, up: uptimeOf(l) ?? 100, down: l.reduce((a, r) => a + r.downtimeMs, 0) })).sort((a, b) => a.up - b.up);
  }, [rows]);

  // Простой по дням (или по часам за сутки) — этот период поверх прошлого.
  const series = useMemo(() => {
    const pick = (l: DowntimeProfile[]) => l.filter((p) => ids.has(p.id));
    if (span <= DAY + 1000) {
      const sum = (l: DowntimeProfile[]) => Array.from({ length: 24 }, (_, h) => pick(l).reduce((a, p) => a + (p.hours[h] ?? 0), 0));
      const c = sum(prof), p = sum(profPrev);
      return { labels: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")), cur: c, prev: p, unit: t("по часам") };
    }
    const n = Math.min(31, Math.ceil(span / DAY));
    const start = new Date(from); start.setHours(0, 0, 0, 0);
    const base = start.getTime();
    const bucket = (l: DowntimeProfile[], b0: number) => {
      const out = new Array(n).fill(0);
      for (const p of pick(l)) for (const [d, ms] of p.days) { const i = Math.round((d - b0) / DAY); if (i >= 0 && i < n) out[i] += ms; }
      return out;
    };
    const c = bucket(prof, base), p = bucket(profPrev, base - n * DAY);
    const labels = Array.from({ length: n }, (_, i) => new Date(base + i * DAY).toLocaleDateString("ru-RU", n <= 7 ? { weekday: "short" } : { day: "numeric" }));
    return { labels, cur: c, prev: p, unit: t("по дням") };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prof, profPrev, span, from, group, rows]);

  // Простой по часам суток — когда чаще всего проблемы.
  const hours = useMemo(() => Array.from({ length: 24 }, (_, h) => prof.filter((p) => ids.has(p.id)).reduce((a, p) => a + (p.hours[h] ?? 0), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prof, group, rows]);

  const worst = cur.filter((r) => r.downtimeMs > 0).sort((a, b) => b.downtimeMs - a.downtimeMs).slice(0, 6);
  const oldById = new Map(old.map((r) => [r.id, r]));

  // Операторы: доступность их целей, простой канала (по худшей цели) и превышение договора.
  const opRows = ops.map((op) => {
    const tids = new Set(op.services.flatMap((s) => s.targets));
    const gs = new Set(op.services.flatMap((s) => s.groups));
    const l = rows.filter((r) => r.checks > 0 && (tids.has(r.id) || gs.has(r.group)));
    const up = uptimeOf(l);
    const down = l.reduce((a, r) => Math.max(a, r.downtimeMs), 0);
    const target = op.slaUptime || 0;
    const allowed = target ? (1 - target / 100) * span : null;
    const over = allowed != null ? Math.max(0, down - allowed) : null;
    return { op, n: l.length, up, down, target, over };
  }).filter((x) => x.n > 0).sort((a, b) => (b.over ?? 0) - (a.over ?? 0) || (a.up ?? 100) - (b.up ?? 100));
  const slaBreaches = opRows.filter((x) => (x.over ?? 0) > 0).length;

  // Геометрия графиков.
  const lo = Math.min(99, Math.floor(Math.min(...groups.map((g) => g.up), sla) * 2) / 2 - 0.5);
  const gW = 600, gLeft = 150, gRight = 70, barH = 18, rowH = 30;
  const gx = (v: number) => gLeft + ((Math.max(lo, v) - lo) / (100 - lo)) * (gW - gLeft - gRight);
  const gH = groups.length * rowH + 34;
  const maxS = Math.max(1, ...series.cur, ...series.prev);
  const niceMax = (() => { const m = maxS / 60e3; const step = m <= 10 ? 2 : m <= 30 ? 5 : m <= 60 ? 10 : m <= 180 ? 30 : 60; return Math.ceil(m / step) * step * 60e3; })();
  const sW = 600, sH = 200, sL = 40, sB = 22, sT = 10;
  const n = series.cur.length;
  const slot = (sW - sL - 8) / n;
  const sy = (v: number) => sT + (1 - v / niceMax) * (sH - sT - sB);
  const maxH = Math.max(1, ...hours);
  const upClass = (v: number | null) => (v == null ? "" : v >= sla ? "c-ok" : v >= sla - 0.5 ? "c-warn" : "c-down");
  const fmtUp = (v: number | null) => (v == null ? "—" : `${v.toFixed(v >= 99.95 ? 3 : 2)}%`);

  return (
    <div className="rd">
      <div className="rd-kpis">
        <div className="rd-kpi">
          <span className="l">{t("Доступность")}{group ? ` · ${group}` : ""}</span>
          <b className={"num " + upClass(k.up)}>{fmtUp(k.up)}</b>
          <Delta cur={k.up} prev={k.upOld} better="up" fmt={(v) => `${v.toFixed(2)} п.п.`} />
        </div>
        <div className="rd-kpi">
          <span className="l">{t("Простой суммарно")}</span>
          <b className="num">{fmtDuration(k.down)}</b>
          <Delta cur={k.down} prev={k.downOld} better="down" fmt={fmtDuration} />
        </div>
        <div className="rd-kpi">
          <span className="l">{t("Инцидентов")}</span>
          <b className="num">{k.inc}</b>
          <Delta cur={k.inc} prev={k.incOld} better="down" fmt={(v) => String(Math.round(v))} />
        </div>
        <div className="rd-kpi">
          <span className="l">{t("Среднее восстановление")}</span>
          <b className="num">{k.mttr == null ? "—" : fmtDuration(k.mttr)}</b>
          <Delta cur={k.mttr} prev={k.mttrOld} better="down" fmt={fmtDuration} />
        </div>
        <div className="rd-kpi">
          <span className="l">{t("Операторы ниже договора")}</span>
          <b className={"num " + (slaBreaches ? "c-down" : "c-ok")}>{opRows.length ? slaBreaches : "—"}</b>
          <span className="rd-delta c-muted">{opRows.length ? (slaBreaches ? opRows.filter((x) => (x.over ?? 0) > 0).map((x) => x.op.name).slice(0, 2).join(", ") : t("все в норме")) : t("операторы не заданы")}</span>
        </div>
      </div>

      <div className="rd-grid">
        <div className="rd-card">
          <div className="rd-h">{t("Доступность по группам")} <span className="c-muted">· {t("линия — цель")} {sla}%</span></div>
          {groups.length === 0 ? <div className="c-muted">{t("Нет данных")}</div> : (
            <svg className="rd-chart rd-chart-g" viewBox={`0 0 ${gW} ${gH}`} role="img" aria-label={t("Доступность по группам")}>
              {[lo, (lo + 100) / 2, 100].map((v) => (
                <g key={v}>
                  <line x1={gx(v)} x2={gx(v)} y1={4} y2={gH - 24} className="rd-grid-l" />
                  <text x={gx(v)} y={gH - 8} textAnchor="middle" className="rd-ax">{v.toFixed(v % 1 ? 2 : 0).replace(".", ",")}</text>
                </g>
              ))}
              {groups.map((g, i) => {
                const y = 6 + i * rowH;
                const c = g.up >= sla ? "var(--ok)" : g.up >= sla - 0.5 ? "var(--warn)" : "var(--down)";
                const w = Math.max(2, gx(g.up) - gLeft);
                return (
                  <g key={g.name} className={"rd-bar" + (group === g.name ? " on" : "")} onClick={() => onGroup(group === g.name ? null : g.name)}>
                    <rect x={0} y={y - 4} width={gW} height={rowH} fill="transparent" />
                    <text x={gLeft - 10} y={y + 13} textAnchor="end" className="rd-lab">{g.name.length > 18 ? g.name.slice(0, 17) + "…" : g.name}</text>
                    <rect x={gLeft} y={y} width={gW - gLeft - gRight} height={barH} rx={5} className="rd-track" />
                    <rect x={gLeft} y={y} width={w} height={barH} rx={5} fill={c} fillOpacity={0.85} />
                    <text x={gW - gRight + 8} y={y + 13} className="rd-val">{fmtUp(g.up)}</text>
                  </g>
                );
              })}
              <line x1={gx(sla)} x2={gx(sla)} y1={0} y2={gH - 24} className="rd-sla" />
            </svg>
          )}
        </div>

        <div className="rd-card">
          <div className="rd-h">{t("Простой")} {series.unit} <span className="rd-legend"><i className="cur" />{t("этот период")} <i className="old" />{t("прошлый")}</span></div>
          <svg className="rd-chart" viewBox={`0 0 ${sW} ${sH}`} role="img" aria-label={t("Простой по дням")}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={sL} x2={sW - 4} y1={sy(niceMax * f)} y2={sy(niceMax * f)} className="rd-grid-l" />
                <text x={sL - 6} y={sy(niceMax * f) + 4} textAnchor="end" className="rd-ax">{Math.round((niceMax * f) / 60e3)}</text>
              </g>
            ))}
            {series.cur.map((v, i) => {
              const x = sL + i * slot;
              const bw = Math.max(2, slot / 2 - 2);
              const pv = series.prev[i] ?? 0;
              const every = Math.ceil(n / 12);
              return (
                <g key={i}>
                  <rect x={x + slot / 2 - bw - 1} y={sy(pv)} width={bw} height={sH - sB - sy(pv)} rx={2} className="rd-old" />
                  <rect x={x + slot / 2 + 1} y={sy(v)} width={bw} height={sH - sB - sy(v)} rx={2} className="rd-cur"><title>{`${series.labels[i]}: ${fmtDuration(v)} (${t("было")} ${fmtDuration(pv)})`}</title></rect>
                  {i % every === 0 && <text x={x + slot / 2} y={sH - 6} textAnchor="middle" className="rd-ax">{series.labels[i]}</text>}
                </g>
              );
            })}
          </svg>
          <div className="rd-sub c-muted">{t("минут без единого ответа")}</div>
        </div>
      </div>

      <div className="rd-card">
        <div className="rd-h">{t("Когда случаются простои")} <span className="c-muted">· {t("по часам суток за период")}</span></div>
        <div className="rd-hours">
          {hours.map((v, h) => (
            <div key={h} className="rd-hour" title={`${String(h).padStart(2, "0")}:00 — ${fmtDuration(v)}`}>
              <i style={{ background: v ? `rgba(var(--down-rgb), ${0.18 + 0.75 * (v / maxH)})` : "rgba(var(--fg-rgb), .05)" }} />
              <span className="num">{h}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rd-grid">
        <div className="rd-card">
          <div className="rd-h">{t("Больше всего простоя")}</div>
          {worst.length === 0 ? <div className="c-muted">{t("Простоев не было")}</div> : (
            <table className="grid rd-table">
              <thead><tr><th>{t("Узел")}</th><th className="r">{t("Простой")}</th><th className="r">{t("Было")}</th><th className="r">{t("Доступность")}</th></tr></thead>
              <tbody>
                {worst.map((r) => {
                  const o = oldById.get(r.id);
                  const d = o ? r.downtimeMs - o.downtimeMs : null;
                  return (
                    <tr key={r.id} onClick={() => onOpen(r.id)}>
                      <td style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name} <span className="c-muted" style={{ fontSize: 11 }}>{r.group}</span></td>
                      <td className="r num">{fmtDuration(r.downtimeMs)}</td>
                      <td className={"r num " + (d == null ? "c-dim" : d > 0 ? "c-down" : "c-ok")}>{o ? fmtDuration(o.downtimeMs) : "—"}</td>
                      <td className={"r num " + upClass(r.uptimePct)}>{fmtUp(r.uptimePct)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="rd-card">
          <div className="rd-h">{t("Операторы")} <span className="c-muted">· {t("простой канала — по худшему узлу")}</span></div>
          {opRows.length === 0 ? <div className="c-muted">{t("Привяжите операторов к целям в разделе «Операторы» — здесь появится их доступность и превышение договора.")}</div> : (
            <table className="grid rd-table">
              <thead><tr><th>{t("Оператор")}</th><th className="r">{t("Доступность")}</th><th className="r">{t("По договору")}</th><th className="r">{t("Сверх договора")}</th></tr></thead>
              <tbody>
                {opRows.map((x) => (
                  <tr key={x.op.id} style={{ cursor: "default" }}>
                    <td>{x.op.name} <span className="c-muted" style={{ fontSize: 11 }}>{x.n} {t("целей")}</span></td>
                    <td className={"r num " + upClass(x.up)}>{fmtUp(x.up)}</td>
                    <td className="r num c-muted">{x.target ? `${x.target}%` : "—"}</td>
                    <td className={"r num " + (x.over == null ? "c-dim" : x.over > 0 ? "c-down" : "c-ok")}>{x.over == null ? "—" : x.over > 0 ? fmtDuration(x.over) : "0"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
