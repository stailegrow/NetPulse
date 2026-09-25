import { t } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ReportRow } from "../types";
import { KIND_LABEL } from "../types";
import { fmtMs, fmtPct } from "../format";
import { Icon } from "../components/ui";

type PeriodKey = "24h" | "7d" | "30d" | "month" | "prev";
const PERIODS: { k: PeriodKey; l: string }[] = [
  { k: "24h", l: "24 часа" },
  { k: "7d", l: "7 дней" },
  { k: "30d", l: "30 дней" },
  { k: "month", l: "Этот месяц" },
  { k: "prev", l: "Прошлый месяц" },
];

function periodRange(k: PeriodKey): [number, number] {
  const now = Date.now();
  const d = new Date();
  switch (k) {
    case "24h": return [now - 86400e3, now];
    case "7d": return [now - 7 * 86400e3, now];
    case "30d": return [now - 30 * 86400e3, now];
    case "month": return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), now];
    case "prev": return [new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), new Date(d.getFullYear(), d.getMonth(), 1).getTime()];
  }
}

type SortKey = "uptime" | "outages" | "downtime" | "loss" | "avg" | "name";

export const fmtDuration = (ms: number) => {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч ${m % 60} мин`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
};

const uptimeClass = (v: number | null) => (v == null ? "c-dim" : v >= 99.9 ? "c-ok" : v >= 99 ? "c-warn" : "c-down");

export function Reports({ onOpen, toast }: { onOpen: (id: string, at?: number) => void; toast: (m: string, k?: string) => void }) {
  const [period, setPeriod] = useState<PeriodKey>("7d");
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [sort, setSort] = useState<{ k: SortKey; asc: boolean }>({ k: "uptime", asc: true });
  const [from, to] = useMemo(() => periodRange(period), [period]);

  useEffect(() => {
    setRows(null);
    api.report(from, to).then(setRows).catch((e) => { toast(String(e), "error"); setRows([]); });
  }, [from, to, toast]);

  const visible = useMemo(() => {
    const list = (rows ?? []).filter((r) => r.checks > 0 && (!group || r.group === group));
    const val = (r: ReportRow): number | string => {
      switch (sort.k) {
        case "uptime": return r.uptimePct ?? 101;
        case "outages": return r.outages;
        case "downtime": return r.downtimeMs;
        case "loss": return r.lossPct;
        case "avg": return r.avgMs ?? -1;
        case "name": return r.name.toLowerCase();
      }
    };
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return sort.asc ? c : -c;
    });
  }, [rows, group, sort]);

  // Итоги по группам (аптайм взвешен по числу проверок).
  const byGroup = useMemo(() => {
    const m = new Map<string, { checks: number; lost: number; outages: number; downtime: number; n: number }>();
    for (const r of (rows ?? []).filter((x) => x.checks > 0)) {
      const g = m.get(r.group) ?? { checks: 0, lost: 0, outages: 0, downtime: 0, n: 0 };
      g.checks += r.checks; g.lost += r.lost; g.outages += r.outages; g.downtime += r.downtimeMs; g.n++;
      m.set(r.group, g);
    }
    return [...m.entries()].map(([name, g]) => ({ name, ...g, uptime: g.checks ? 100 - (g.lost * 100) / g.checks : null }));
  }, [rows]);

  const total = useMemo(() => {
    const list = visible;
    const checks = list.reduce((a, r) => a + r.checks, 0);
    const lost = list.reduce((a, r) => a + r.lost, 0);
    return {
      uptime: checks ? 100 - (lost * 100) / checks : null,
      outages: list.reduce((a, r) => a + r.outages, 0),
      downtime: list.reduce((a, r) => a + r.downtimeMs, 0),
      worst: list.filter((r) => r.uptimePct != null).sort((a, b) => (a.uptimePct ?? 0) - (b.uptimePct ?? 0))[0],
    };
  }, [visible]);

  const th = (k: SortKey, label: string, right = true) => (
    <th className={right ? "r" : ""} style={{ cursor: "pointer" }} onClick={() => setSort((s) => ({ k, asc: s.k === k ? !s.asc : k === "uptime" || k === "name" }))}>
      {label}{sort.k === k ? (sort.asc ? " ▲" : " ▼") : ""}
    </th>
  );

  const exportFile = async () => {
    try {
      const p = await api.exportReport(from, to);
      if (p) toast(`Отчёт сохранён: ${p}`, "ok");
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const fmtD = (ts: number) => new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <div className="toolbar">
        <div className="chips">
          {PERIODS.map((p) => <button key={p.k} className={period === p.k ? "on" : ""} onClick={() => setPeriod(p.k)}>{t(p.l)}</button>)}
        </div>
        <span className="c-muted num" style={{ fontSize: 12 }}>{fmtD(from)} — {fmtD(to)}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={exportFile} disabled={!rows?.length}><Icon name="download" size={13} />{t("Экспорт в CSV")}</button>
      </div>

      <div className="stats-row">
        <div className="stat-card" style={{ cursor: "default" }}>
          <div className={"v " + uptimeClass(total.uptime)}>{total.uptime == null ? "—" : `${total.uptime.toFixed(2)}%`}</div>
          <div className="l">{t("Средний аптайм")}</div>
        </div>
        <div className="stat-card" style={{ cursor: "default" }}>
          <div className={"v " + (total.outages ? "c-down" : "")}>{total.outages}</div>
          <div className="l">{t("Простоев")}</div>
        </div>
        <div className="stat-card" style={{ cursor: "default" }}>
          <div className="v">{fmtDuration(total.downtime)}</div>
          <div className="l">{t("Простой суммарно")}</div>
        </div>
        <div className="stat-card" style={{ cursor: total.worst ? "pointer" : "default", minWidth: 220 }} onClick={() => total.worst && onOpen(total.worst.id)}>
          <div className={"v " + uptimeClass(total.worst?.uptimePct ?? null)} style={{ fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260 }}>{total.worst ? total.worst.name : "—"}</div>
          <div className="l">Худшая цель{total.worst ? ` · ${total.worst.uptimePct?.toFixed(2)}%` : ""}</div>
        </div>
      </div>

      <div className="page-pad" style={{ paddingTop: 0 }}>
        {byGroup.length > 1 && (
          <div className="section" style={{ padding: "4px 0 14px" }}>
            <div className="section-title">{t("По группам")}</div>
            <div className="chips" style={{ flexWrap: "wrap", height: "auto" }}>
              <button className={!group ? "on" : ""} onClick={() => setGroup(null)}>{t("Все")}</button>
              {byGroup.map((g) => (
                <button key={g.name} className={group === g.name ? "on" : ""} onClick={() => setGroup(group === g.name ? null : g.name)} title={`${g.n} целей · простоев ${g.outages} · ${fmtDuration(g.downtime)}`}>
                  {g.name} <b className={"num " + uptimeClass(g.uptime)} style={{ marginLeft: 6 }}>{g.uptime == null ? "—" : `${g.uptime.toFixed(2)}%`}</b>
                </button>
              ))}
            </div>
          </div>
        )}

        {rows == null ? (
          <div className="empty"><div>{t("Считаю отчёт…")}</div></div>
        ) : !visible.length ? (
          <div className="empty"><h2>{t("Нет данных за период")}</h2><div>{t("Отчёт строится по минутной истории. Она копится, пока программа запущена.")}</div></div>
        ) : (
          <div className="table-wrap" style={{ padding: 0 }}>
            <table className="grid report-table">
              <thead>
                <tr>
                  {th("name", "Цель", false)}
                  <th>{t("Группа")}</th>
                  {th("uptime", "Аптайм")}
                  {th("outages", "Простои")}
                  {th("downtime", "Простой всего")}
                  <th className="r" title={t("События «недоступен» и «был недоступен» (от 5 секунд)")}>{t("Инциденты")}</th>
                  {th("loss", "Потери")}
                  {th("avg", "Средн., мс")}
                  <th className="r">{t("Макс., мс")}</th>
                  <th title={t("Час суток с наибольшими потерями (при равных — с наибольшей задержкой)")}>{t("Худший час")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} onClick={() => onOpen(r.id)}>
                    <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {r.name} <span className="kind" style={{ marginLeft: 4 }}>{r.kind ? KIND_LABEL[r.kind] : ""}</span>
                      <div className="c-muted num" style={{ fontSize: 11 }}>{r.host}</div>
                    </td>
                    <td className="c-muted">{r.group}</td>
                    <td className={"r num " + uptimeClass(r.uptimePct)} style={{ fontWeight: 600 }}>{r.uptimePct == null ? "—" : `${r.uptimePct.toFixed(r.uptimePct >= 99.99 ? 3 : 2)}%`}</td>
                    <td className={"r num " + (r.outages ? "c-down" : "c-dim")}>{r.outages}</td>
                    <td className={"r num " + (r.downtimeMs ? "" : "c-dim")}>{r.downtimeMs ? fmtDuration(r.downtimeMs) : "—"}</td>
                    <td className={"r num " + (r.incidents ? "" : "c-dim")}>{r.incidents}</td>
                    <td className={"r num " + (r.lossPct > 5 ? "c-down" : r.lossPct > 1 ? "c-warn" : "c-muted")}>{fmtPct(r.lossPct)}%</td>
                    <td className="r num">{fmtMs(r.avgMs, 1)}</td>
                    <td className="r num c-muted">{fmtMs(r.maxMs, 0)}</td>
                    <td className="c-muted num">
                      {r.worstHour == null ? "—" : `${String(r.worstHour).padStart(2, "0")}:00–${String((r.worstHour + 1) % 24).padStart(2, "0")}:00`}
                      {r.worstHour != null && r.worstHourLoss > 0 && <span className={r.worstHourLoss > 5 ? "c-down" : "c-warn"}> · {fmtPct(r.worstHourLoss)}%</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="c-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          Аптайм — доля успешных проверок. Простой — минуты, в которые не прошла ни одна проверка. Отчёт строится по минутной истории (хранится {""}
          по настройке «Хранить минутные агрегаты»).
        </div>
      </div>
    </>
  );
}
