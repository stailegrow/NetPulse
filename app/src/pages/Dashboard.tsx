import { t } from "../i18n";
import { useMemo, useState } from "react";
import type { Health, TargetSummary } from "../types";
import { HEALTH_LABEL, HEALTH_ORDER as ORDER, KIND_LABEL } from "../types";
import { fmtMs, fmtPct, latencyClass, lossClass } from "../format";
import { problemText } from "../problem";
import { Sparkline } from "../components/Sparkline";
import { RouteBadge, Dot, Icon, MutedBadge } from "../components/ui";
import { GraphsView } from "./GraphsView";

type Filter = "all" | "problems" | "down" | "paused";

/** Ключ служебной секции «Проблемные узлы» на вкладке «Все цели». */
export const PROBLEMS_KEY = "\u0000problems";
const PROBLEM_HEALTH: Health[] = ["down", "dependent", "crit", "bad", "warn"];


interface Props {
  items: TargetSummary[];
  group: string | null;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onToggle: (s: TargetSummary) => void;
  onContext: (e: React.MouseEvent, s: TargetSummary) => void;
  /** Порядок групп, заданный пользователем перетаскиванием. */
  groupOrder: string[];
  /** Выделенные цели для массового изменения. */
  selected: Set<string>;
  onSelect: (ids: string[], on: boolean) => void;
  onBulk: () => void;
}

type View = "table" | "tiles" | "graphs";

export function Dashboard({ items, group, onOpen, onAdd, onToggle, onContext, groupOrder, selected, onSelect, onBulk }: Props) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<View>(() => {
    try { return (localStorage.getItem("np.view") as View) || "table"; } catch { return "table"; }
  });
  const [sortProblems, setSortProblems] = useState(true);

  const setViewPersist = (v: View) => {
    setView(v);
    try { localStorage.setItem("np.view", v); } catch { /* ignore */ }
  };

  const showAll = !group;
  const scoped = useMemo(() => (showAll ? items : items.filter((i) => i.group === group)), [items, group, showAll]);
  const counts = useMemo(() => ({
    all: scoped.length,
    ok: scoped.filter((i) => i.health === "ok").length,
    problems: scoped.filter((i) => i.health === "warn" || i.health === "bad" || i.health === "crit").length,
    down: scoped.filter((i) => i.health === "down" || i.health === "dependent").length,
    paused: scoped.filter((i) => i.health === "paused").length,
  }), [scoped]);

  const visible = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = scoped.filter((i) =>
      (!ql || i.name.toLowerCase().includes(ql) || i.host.toLowerCase().includes(ql) || (i.resolvedIp ?? "").includes(ql)) &&
      (filter === "all" || (filter === "problems" && ["warn", "bad", "crit", "down", "dependent"].includes(i.health)) || (filter === "down" && (i.health === "down" || i.health === "dependent")) || (filter === "paused" && i.health === "paused")),
    );
    if (sortProblems) list = [...list].sort((a, b) => ORDER[a.health] - ORDER[b.health]);
    return list;
  }, [scoped, q, filter, sortProblems]);

  // На «Все цели» проблемные узлы поднимаются в отдельную секцию сверху, независимо от группы.
  const problems = useMemo(
    () => (showAll ? visible.filter((i) => PROBLEM_HEALTH.includes(i.health)).sort((a, b) => ORDER[a.health] - ORDER[b.health]) : []),
    [visible, showAll],
  );

  const grouped = useMemo(() => {
    const m = new Map<string, TargetSummary[]>();
    const skip = new Set(problems.map((p) => p.id));
    for (const i of visible) {
      if (skip.has(i.id)) continue;
      if (!m.has(i.group)) m.set(i.group, []);
      m.get(i.group)!.push(i);
    }
    // Группы идут в порядке пользователя; «Проблемы сверху» сортирует цели внутри группы.
    const idx = (g: string) => { const i = groupOrder.indexOf(g); return i < 0 ? 1e6 : i; };
    const list = [...m.entries()].sort((a, b) => idx(a[0]) - idx(b[0]) || a[0].localeCompare(b[0], "ru"));
    return problems.length ? ([[PROBLEMS_KEY, problems], ...list] as [string, TargetSummary[]][]) : list;
  }, [visible, groupOrder, problems]);

  if (!items.length) {
    return (
      <div className="empty">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none"><path d="M2 13h5l2-5 3 10 2.5-13L17 13h5" stroke="var(--dim)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>
        <h2>{t("Пока нечего мониторить")}</h2>
        <div>{t("Добавьте серверы, сайты и сервисы компании — NetPulse начнёт следить за ними сразу.")}</div>
        <button className="btn primary" onClick={onAdd}><Icon name="plus" /> {t("Добавить цель")}</button>
      </div>
    );
  }

  const cards: { k: Filter; v: number; l: string; c?: string }[] = [
    { k: "all", v: counts.all, l: t("Всего целей") },
    { k: "problems", v: counts.problems + counts.down, l: t("С проблемами"), c: counts.problems + counts.down ? "c-warn" : "" },
    { k: "down", v: counts.down, l: t("Недоступны"), c: counts.down ? "c-down" : "" },
    { k: "paused", v: counts.paused, l: t("На паузе") },
  ];

  const renderTile = (s: TargetSummary, withGroup: boolean) => (
            <div key={s.id} className={"tile " + s.health} onClick={() => onOpen(s.id)} onContextMenu={(e) => onContext(e, s)}>
              <div className="top" draggable onDragStart={(e) => { e.dataTransfer.setData("text/netpulse-target", s.id); e.dataTransfer.effectAllowed = "move"; }}>
                <Dot h={s.health} />
                <span className="nm">{s.name}</span>
                <MutedBadge on={s.alertsEnabled} />
                <span style={{ flex: 1 }} />
                <RouteBadge at={s.routeChangedAt} text={s.routeChange} />
                <span className="kind">{KIND_LABEL[s.kind]}</span>
              </div>
              <div className="hs">{s.host}{withGroup && <span className="grp-chip">{s.group}</span>}</div>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
                <div className={"big " + (s.health === "paused" ? "c-dim" : latencyClass(s.lastRtt, s.thresholds))}>
                  {s.health === "paused" ? "—" : s.lastRtt == null ? "✕" : fmtMs(s.lastRtt)}<small>{s.lastRtt != null ? "мс" : ""}</small>
                </div>
                <Sparkline data={s.spark} th={s.thresholds} width={130} height={30} />
              </div>
              <div className="meta" style={{ marginTop: 6 }}>
                <span>{t("ср.")} <b className="num c-muted">{fmtMs(s.avgRtt)}</b></span>
                <span>{t("потери")} <b className={"num " + lossClass(s.lossPct, s.thresholds)}>{fmtPct(s.lossPct)}%</b></span>
                <span>jitter <b className="num c-muted">{fmtMs(s.jitter)}</b></span>
              </div>
              {problemText(s) && <div className={"err" + (s.health === "down" || s.health === "dependent" ? "" : " warn")} style={{ marginTop: 6, maxWidth: "100%" }} title={problemText(s)}>{problemText(s)}</div>}
              {s.health === "dependent" && <div className="c-muted" style={{ marginTop: 6, fontSize: 11.5 }}>из-за недоступности «{s.blockedBy}»</div>}
            </div>
  );

  return (
    <>
      <div className="stats-row">
        {cards.map((c) => (
          <div key={c.k} className={"stat-card" + (filter === c.k ? " on" : "")} onClick={() => setFilter(filter === c.k ? "all" : c.k)}>
            <div className={"v " + (c.c ?? "")}>{c.v}</div>
            <div className="l">{c.l}</div>
          </div>
        ))}
        <div className="stat-card" style={{ cursor: "default" }}>
          <div className="v c-ok">{counts.all - counts.paused ? Math.round((counts.ok / (counts.all - counts.paused)) * 100) : 0}%</div>
          <div className="l">{t("В норме сейчас")}</div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, alignSelf: "flex-end" }}>
          <div style={{ position: "relative" }}>
            <input className="input search" placeholder={t("Поиск по имени, хосту, IP")} value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 30 }} />
            <span style={{ position: "absolute", left: 9, top: 8, color: "var(--muted)" }}><Icon name="search" size={14} /></span>
          </div>
          <button className={"btn sm " + (sortProblems ? "" : "ghost")} onClick={() => setSortProblems(!sortProblems)} title={t("Проблемные цели наверху")}>{t("Проблемы сверху")}</button>
          <div className="chips">
            <button className={view === "table" ? "on" : ""} onClick={() => setViewPersist("table")} title={t("Таблица")}><Icon name="rows" size={13} /></button>
            <button className={view === "tiles" ? "on" : ""} onClick={() => setViewPersist("tiles")} title={t("Плитки")}><Icon name="tiles" size={13} /></button>
            <button className={view === "graphs" ? "on" : ""} onClick={() => setViewPersist("graphs")} title={t("Графики всех целей")}><Icon name="chart" size={13} /></button>
          </div>
        </div>
      </div>

      {scoped.length > 0 && !visible.length ? (
        <div className="empty">
          <h2>{t("Ничего не найдено")}</h2>
          <div>{t("Ни одна цель не подходит под поиск или фильтр статуса.")}</div>
          <button className="btn" onClick={() => { setQ(""); setFilter("all"); }}>{t("Сбросить поиск и фильтры")}</button>
        </div>
      ) : !showAll && !scoped.length ? (
        <div className="empty">
          <h2>В группе «{group}» пока нет целей</h2>
          <div>{t("Добавьте цель или перетащите существующую из списка «Все цели» на название группы слева.")}</div>
          <button className="btn primary" onClick={onAdd}><Icon name="plus" /> {t("Добавить цель в группу")}</button>
        </div>
      ) : view === "graphs" ? (
        <GraphsView items={visible} grouped={grouped} showGroups={showAll} onOpen={onOpen} onContext={onContext} />
      ) : view === "tiles" ? (
        showAll && problems.length ? (
          <>
            <div className="sec-title problems-title">{t("Проблемные цели")} <span className="badge red">{problems.length}</span></div>
            <div className="tiles">{problems.map((s) => renderTile(s, true))}</div>
            <div className="sec-title">{t("Остальные цели")}</div>
            <div className="tiles">{visible.filter((s) => !problems.includes(s)).map((s) => renderTile(s, false))}</div>
          </>
        ) : (
          <div className="tiles">{visible.map((s) => renderTile(s, false))}</div>
        )
      ) : (
        <div className="table-wrap">
          {selected.size > 0 && (
            <div className="select-bar">
              <b>Выбрано: {selected.size}</b>
              <button className="btn primary sm" onClick={onBulk}>{t("Изменить выбранные…")}</button>
              <button className="btn ghost sm" onClick={() => onSelect([...selected], false)}>{t("Снять выделение")}</button>
              <span className="c-muted" style={{ fontSize: 11.5 }}>{t("шаблон, группа, интервал, уведомления, пауза, родитель")}</span>
            </div>
          )}
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 28 }} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" title={t("Выделить все видимые")} checked={visible.length > 0 && visible.every((v) => selected.has(v.id))} onChange={(e) => onSelect(visible.map((v) => v.id), e.target.checked)} />
                </th>
                <th style={{ width: "30%" }}>{t("Цель")}</th>
                <th>{t("Тип")}</th>
                <th>{t("Статус")}</th>
                <th className="r">{t("Текущ., мс")}</th>
                <th className="r">{t("Средн.")}</th>
                <th className="r">{t("Мин / Макс")}</th>
                <th className="r">Jitter</th>
                <th className="r">{t("Потери")}</th>
                <th>Последние {60} проверок</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(([g, list]) => (
                <GroupRows key={g} name={showAll ? g : null} problems={g === PROBLEMS_KEY} list={list} onOpen={onOpen} onToggle={onToggle} onContext={onContext} selected={selected} onSelect={onSelect} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function GroupRows({ name, problems, list, onOpen, onToggle, onContext, selected, onSelect }: { name: string | null; problems?: boolean; list: TargetSummary[]; onOpen: (id: string) => void; onToggle: (s: TargetSummary) => void; onContext: (e: React.MouseEvent, s: TargetSummary) => void; selected: Set<string>; onSelect: (ids: string[], on: boolean) => void }) {
  const bad = list.filter((s) => s.health === "down" || s.health === "crit").length;
  return (
    <>
      {name && (
        <tr className={"group-row" + (problems ? " problems" : "")}>
          <td style={{ width: 28 }}>
            <input type="checkbox" title={t("Выделить группу")} checked={list.length > 0 && list.every((s) => selected.has(s.id))} onChange={(e) => onSelect(list.map((s) => s.id), e.target.checked)} />
          </td>
          <td colSpan={10}>
            {problems ? t("Проблемные цели") : name} <span className="badge" style={{ marginLeft: 6 }}>{list.length}</span>
            {!problems && bad > 0 && <span className="badge red" style={{ marginLeft: 6 }}>{bad}</span>}
          </td>
        </tr>
      )}
      {list.map((s) => {
        const th = s.thresholds;
        return (
          <tr key={s.id} className={selected.has(s.id) ? "picked" : ""} onClick={(e) => { if (e.metaKey || e.ctrlKey) onSelect([s.id], !selected.has(s.id)); else onOpen(s.id); }} onContextMenu={(e) => onContext(e, s)} draggable onDragStart={(e) => { e.dataTransfer.setData("text/netpulse-target", s.id); e.dataTransfer.effectAllowed = "move"; }}>
            <td style={{ width: 28 }} onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={selected.has(s.id)} onChange={(e) => onSelect([s.id], e.target.checked)} />
            </td>
            <td style={{ maxWidth: 0 }}>
              <div className="name-cell">
                <Dot h={s.health} />
                <div style={{ minWidth: 0 }}>
                  <div className="t">{s.name} {problems && <span className="grp-chip">{s.group}</span>} <MutedBadge on={s.alertsEnabled} /> <RouteBadge at={s.routeChangedAt} text={s.routeChange} /></div>
                  <div className="h">{s.host}{s.resolvedIp && s.resolvedIp !== s.host ? ` · ${s.resolvedIp}` : ""}</div>
                </div>
              </div>
            </td>
            <td><span className="kind">{KIND_LABEL[s.kind]}</span></td>
            <td>
              {s.health === "dependent" ? (
                <span className="pill dependent" title={`Недоступен, потому что недоступен родительский узел «${s.blockedBy}». Уведомления не отправляются.`}>из-за «{s.blockedBy}»</span>
              ) : s.health === "down" && problemText(s) ? (
                <span className="err" title={problemText(s)}>{problemText(s)}</span>
              ) : (
                <span className={"pill " + s.health} title={problemText(s) || undefined}>{HEALTH_LABEL[s.health]}{s.statusCode ? ` · ${s.statusCode}` : ""}{problemText(s) ? " · " + problemText(s) : ""}</span>
              )}
            </td>
            <td className={"r num " + (s.health === "paused" ? "c-dim" : latencyClass(s.lastRtt, th))} style={{ fontWeight: 600 }}>
              {s.health === "paused" ? "—" : s.lastRtt == null ? "✕" : fmtMs(s.lastRtt)}
            </td>
            <td className={"r num " + (s.avgRtt == null ? "c-dim" : latencyClass(s.avgRtt, th))}>{fmtMs(s.avgRtt)}</td>
            <td className="r num c-muted">{fmtMs(s.minRtt)} / {fmtMs(s.maxRtt)}</td>
            <td className="r num c-muted">{fmtMs(s.jitter)}</td>
            <td className={"r num " + lossClass(s.lossPct, th)}>{fmtPct(s.lossPct)}%</td>
            <td><Sparkline data={s.spark} th={th} /></td>
            <td className="r">
              <span className="row-actions">
                <button className="btn sm ghost icon-btn" title={s.enabled ? "Пауза" : "Запустить"} onClick={(e) => { e.stopPropagation(); onToggle(s); }}>
                  <Icon name={s.enabled ? "pause" : "play"} size={13} />
                </button>
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}
