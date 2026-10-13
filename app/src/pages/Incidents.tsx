import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { fmtDateTime, fmtTime, plural } from "../format";
import type { EventRecord, Incident, TargetOperator, TargetSummary } from "../types";
import { Events } from "./Events";
import { OperatorCard, TicketModal } from "../components/OperatorCard";
import { fmtDuration } from "./Reports";
import { Icon, stripMark } from "../components/ui";
import { useIncidentControl } from "../control";

type Tab = "open" | "history" | "journal";
type Period = 1 | 7 | 30;

/** Длительность с секундами для живого таймера: «14:07», «2:05:31». */
function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function dayLabel(ts: number) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86400e3);
  if (diff === 0) return t("Сегодня");
  if (diff === 1) return t("Вчера");
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "short" });
}

export function Incidents({ items, onOpen, refreshKey, toast, onOperators, tabReq }: {
  tabReq?: { tab: Tab };
  items: TargetSummary[];
  onOpen: (id: string, at?: number) => void;
  refreshKey: number;
  toast: (m: string, k?: string) => void;
  onOperators: (targetId?: string) => void;
}) {
  const control = useIncidentControl();
  const [tab, setTab] = useState<Tab>(() => { try { return (localStorage.getItem("np.incTab") as Tab) || "open"; } catch { return "open"; } });
  const [period, setPeriod] = useState<Period>(7);
  const [list, setList] = useState<Incident[] | null>(null);
  const [outages, setOutages] = useState<EventRecord[]>([]);
  const [group, setGroup] = useState("");
  const [sev, setSev] = useState<"" | "critical" | "warning">("");
  const [q, setQ] = useState("");
  const [now, setNow] = useState(Date.now());
  const [ticket, setTicket] = useState<{ inc: Incident; op?: string } | null>(null);
  const setTabP = (x: Tab) => { setTab(x); try { localStorage.setItem("np.incTab", x); } catch { /* */ } };
  useEffect(() => { if (tabReq) setTabP(tabReq.tab); }, [tabReq]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      const to = Date.now() + 60e3;
      api.incidents(to - period * 86400e3 - 60e3, to, 2000).then((l) => alive && setList(l)).catch(() => alive && setList([]));
      api.events(2000).then((ev) => alive && setOutages(ev.filter((e) => e.kind === "outage" && e.ts > Date.now() - period * 86400e3))).catch(() => {});
    };
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [period, refreshKey]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const upd = (i: Incident) => setList((l) => (l ? l.map((x) => (x.id === i.id ? i : x)) : l));
  const groups = useMemo(() => [...new Set((list ?? []).map((i) => i.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru")), [list]);
  const open = (list ?? []).filter((i) => i.closed == null);
  const hist = (list ?? []).filter((i) => i.closed != null)
    .filter((i) => (!group || i.group === group) && (!sev || i.severity === sev))
    .filter((i) => { const s = q.trim().toLowerCase(); return !s || i.title.toLowerCase().includes(s) || i.targets.some((x) => x.name.toLowerCase().includes(s) || x.host.includes(s)) || (i.ticket?.number ?? "").includes(s); });

  // Сводка за период: только закрытые с уведомлением или длиннее минуты.
  const stats = useMemo(() => {
    const all = (list ?? []);
    const done = all.filter((i) => i.closed != null);
    const len = (i: Incident) => (i.closed ?? now) - i.opened;
    const mttr = done.length ? done.reduce((a, i) => a + len(i), 0) / done.length : 0;
    const acked = all.filter((i) => i.ackAt);
    const tta = acked.length ? acked.reduce((a, i) => a + (i.ackAt! - i.opened), 0) / acked.length : 0;
    const byGroup = new Map<string, number>();
    for (const i of all) byGroup.set(i.group || t("Разные"), (byGroup.get(i.group || t("Разные")) ?? 0) + len(i));
    const worst = [...byGroup].sort((a, b) => b[1] - a[1])[0];
    return { count: all.length, mttr, tta, worst, total: all.reduce((a, i) => a + len(i), 0) };
  }, [list, now]);

  // История по дням + короткие обрывы, свёрнутые в одну строку на день.
  const days = useMemo(() => {
    const m = new Map<string, { ts: number; inc: Incident[]; out: EventRecord[] }>();
    const key = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return String(d.getTime()); };
    for (const i of hist) { const k = key(i.opened); if (!m.has(k)) m.set(k, { ts: +k, inc: [], out: [] }); m.get(k)!.inc.push(i); }
    if (!sev || sev === "critical") for (const e of outages) {
      if (group && !items.some((x) => x.id === e.targetId && x.group === group)) continue;
      if (q && !(e.targetName ?? "").toLowerCase().includes(q.toLowerCase())) continue;
      const k = key(e.ts); if (!m.has(k)) m.set(k, { ts: +k, inc: [], out: [] }); m.get(k)!.out.push(e);
    }
    return [...m.values()].sort((a, b) => b.ts - a.ts);
  }, [hist, outages, group, sev, q, items]);

  return (
    <div className="incp">
      <div className="toolbar">
        <div className="chips">
          <button className={tab === "open" ? "on" : ""} onClick={() => setTabP("open")}>{t("Открытые")} {open.length > 0 && <span className={"badge" + (control ? " red" : "")} style={{ marginLeft: 4 }}>{open.length}</span>}</button>
          <button className={tab === "history" ? "on" : ""} onClick={() => setTabP("history")}>{t("История")}</button>
          <button className={tab === "journal" ? "on" : ""} onClick={() => setTabP("journal")}>{t("Журнал")}</button>
        </div>
        {tab === "history" && (
          <>
            <div className="chips">
              {([1, 7, 30] as Period[]).map((p) => <button key={p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>{p === 1 ? t("24 часа") : `${p} ${t("дней")}`}</button>)}
            </div>
            <select className="select" style={{ width: 170 }} value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">{t("Все группы")}</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <div className="chips">
              <button className={sev === "" ? "on" : ""} onClick={() => setSev("")}>{t("Все")}</button>
              <button className={sev === "critical" ? "on" : ""} onClick={() => setSev("critical")}>{t("Аварии")}</button>
              <button className={sev === "warning" ? "on" : ""} onClick={() => setSev("warning")}>{t("Ухудшения")}</button>
            </div>
            <input className="input search" placeholder={t("Узел, адрес, номер заявки")} value={q} onChange={(e) => setQ(e.target.value)} />
          </>
        )}
      </div>

      {tab === "journal" && <Events onOpen={onOpen} refreshKey={refreshKey} />}

      {tab === "open" && (
        <div className="incp-body">
          {list === null ? <div className="empty">{t("Загружаю…")}</div> : open.length === 0 ? (
            <div className="empty incp-calm">
              <span className="incp-ok">✓</span>
              <h2>{t("Сейчас всё в порядке")}</h2>
              <div>{t("Открытых инцидентов нет. Короткие обрывы и закрытые инциденты — во вкладке «История».")}</div>
            </div>
          ) : open.map((i) => (
            <IncidentCard key={i.id} i={i} now={now} items={items} onOpen={onOpen} toast={toast} onChange={upd}
              onTicket={(op) => setTicket({ inc: i, op })} onOperators={onOperators} expanded />
          ))}
        </div>
      )}

      {tab === "history" && (
        <div className="incp-body">
          <div className="stats-row" style={{ padding: 0 }}>
            <div className="stat-card"><div className="v">{stats.count}</div><div className="l">{t("инцидентов за период")}</div></div>
            <div className="stat-card"><div className="v">{fmtDuration(stats.total)}</div><div className="l">{t("простой суммарно")}</div></div>
            <div className="stat-card"><div className="v">{stats.mttr ? fmtDuration(stats.mttr) : "—"}</div><div className="l">{t("среднее восстановление")}</div></div>
            {control && <div className="stat-card"><div className="v">{stats.tta ? fmtDuration(stats.tta) : "—"}</div><div className="l">{t("среднее время до «взял»")}</div></div>}
            {stats.worst && <div className="stat-card"><div className="v" style={{ fontSize: 17, paddingTop: 4 }}>{stats.worst[0]}</div><div className="l">{t("больше всего простоя")}</div></div>}
          </div>
          {list === null && <div className="empty">{t("Загружаю…")}</div>}
          {list !== null && days.length === 0 && <div className="empty"><h2>{t("Ничего не найдено")}</h2><div>{t("За выбранный период инцидентов нет.")}</div></div>}
          {days.map((d) => (
            <div key={d.ts} className="incp-day">
              <div className="incp-day-h">{dayLabel(d.ts)} <span className="c-muted">· {plural(d.inc.length, "инцидент", "инцидента", "инцидентов")}</span></div>
              {d.inc.map((i) => (
                <IncidentCard key={i.id} i={i} now={now} items={items} onOpen={onOpen} toast={toast} onChange={upd} onTicket={(op) => setTicket({ inc: i, op })} onOperators={onOperators} />
              ))}
              {d.out.length > 0 && <OutageRow list={d.out} onOpen={onOpen} />}
            </div>
          ))}
        </div>
      )}

      {ticket && <TicketModal incident={ticket.inc} operatorId={ticket.op} onClose={() => setTicket(null)} onSaved={upd} toast={toast} />}
    </div>
  );
}

function OutageRow({ list, onOpen }: { list: EventRecord[]; onOpen: (id: string, at?: number) => void }) {
  const [open, setOpen] = useState(false);
  const nodes = new Set(list.map((e) => e.targetId)).size;
  return (
    <div className="inc-card short">
      <div className="inc-main" onClick={() => setOpen((v) => !v)} style={{ cursor: "pointer" }}>
        <span className="dot unknown" />
        <div className="inc-txt">
          <div className="inc-title">{t("Короткие обрывы")}: {plural(nodes, "узел", "узла", "узлов")}, {plural(list.length, "раз", "раза", "раз")}</div>
          <div className="inc-sub">{t("Не дольше порога уведомления — в чат не отправлялись")} · {open ? t("свернуть") : t("раскрыть список")}</div>
        </div>
      </div>
      {open && (
        <div className="inc-log">
          {list.slice(0, 60).map((e) => (
            <div key={e.id} className="inc-log-row ev-click" onClick={() => e.targetId && onOpen(e.targetId, e.ts)}>
              <span className="num c-muted">{fmtTime(e.ts, true)}</span><span>{stripMark(e.message)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function IncidentCard({ i, now, items, onOpen, toast, onChange, onTicket, onOperators, expanded }: {
  i: Incident;
  now: number;
  items: TargetSummary[];
  onOpen: (id: string, at?: number) => void;
  toast: (m: string, k?: string) => void;
  onChange: (i: Incident) => void;
  onTicket: (operatorId?: string) => void;
  onOperators: (targetId?: string) => void;
  expanded?: boolean;
}) {
  const control = useIncidentControl();
  const [show, setShow] = useState(!!expanded);
  const [ops, setOps] = useState<TargetOperator[] | null>(null);
  const [note, setNote] = useState("");
  const isOpen = i.closed == null;
  const muted = (i.mutedUntil ?? 0) > now;
  const firstId = i.targets[0]?.id;
  useEffect(() => {
    if (show && firstId && ops === null) api.targetOperators(firstId).then(setOps).catch(() => setOps([]));
  }, [show, firstId, ops]);

  const act = (p: Promise<Incident>, msg: string) => p.then((x) => { onChange(x); toast(msg, "ok"); }).catch((e) => toast(String(e), "error"));
  const len = (i.closed ?? now) - i.opened;
  const st = !isOpen ? "ok" : i.severity === "critical" ? "down" : "warn";
  const activeN = i.targets.filter((x) => x.until == null).length;
  const sla = ops?.[0]?.operator;
  const slaLate = isOpen && i.ticket && sla && sla.slaFixHours > 0 && now - i.ticket.at > sla.slaFixHours * 3600e3;
  return (
    <div className={"inc-card " + (isOpen ? "open " : "") + st}>
      <div className="inc-main" onClick={() => setShow((v) => !v)}>
        <span className={"dot " + st} />
        <div className="inc-txt">
          <div className="inc-title">{i.title}</div>
          <div className="inc-sub">
            {i.group && <>{i.group} · </>}
            {isOpen ? `${t("с")} ${fmtTime(i.opened, false)}` : `${fmtTime(i.opened, false)}–${fmtTime(i.closed!, false)}`}
            {i.cause && <> · {i.cause}</>}
          </div>
          <div className="inc-tags">
            {control && (i.ackBy ? <span className="ttag ok"><Icon name="hand" size={12} />{i.ackBy}{i.ackAt ? ` · ${fmtTime(i.ackAt, false)}` : ""}</span> : isOpen && <span className="ttag warnt">{t("никто не взял")}</span>)}
            {control && i.ticket && <span className="ttag"><Icon name="note" size={12} />{i.ticket.operatorName || t("оператор")}{i.ticket.number ? ` · № ${i.ticket.number}` : ""}</span>}
            {control && muted && <span className="ttag"><Icon name="bellOff" size={12} />{t("тишина до")} {fmtTime(i.mutedUntil!, false)}</span>}
            {i.notifiedAt ? <span className="ttag"><Icon name="send" size={12} />{t("отправлено")}</span> : isOpen && <span className="ttag">{t("ещё не отправлено — ждём порога")}</span>}
            {control && slaLate && <span className="ttag downt">{t("просрочен SLA оператора")}</span>}
          </div>
        </div>
        <div className={"inc-time num" + (isOpen ? " live" : "")}>{isOpen ? clock(len) : fmtDuration(len)}</div>
      </div>
      {isOpen && (
        <div className="inc-actions">
          {control && !i.ackBy && <button className="btn primary sm" onClick={() => act(api.incidentAck(i.id), t("Взято в работу"))}><Icon name="hand" size={13} />{t("Взять в работу")}</button>}
          {control && <button className="btn sm" onClick={() => onTicket()}><Icon name="clipboard" size={13} />{t("Заявка оператору")}</button>}
          {control && (muted
            ? <button className="btn sm" onClick={() => act(api.incidentMute(i.id, 0), t("Тишина снята"))}><Icon name="bell" size={13} />{t("Снять тишину")}</button>
            : <button className="btn sm" onClick={() => act(api.incidentMute(i.id, 60), t("Тишина на 1 час"))}><Icon name="bellOff" size={13} />{t("Тишина 1 ч")}</button>)}
          {firstId && <button className="btn sm ghost" onClick={() => onOpen(firstId, i.opened)}><Icon name="chart" size={13} />{t("График")}</button>}
        </div>
      )}
      {show && (
        <div className="inc-more">
          <div className="inc-cols">
            <div style={{ minWidth: 0 }}>
              <div className="inc-h">{t("Узлы")} · {isOpen ? `${activeN} ${t("из")} ${i.targets.length} ${t("не в норме")}` : i.targets.length}</div>
              {i.targets.map((x) => {
                const live = items.find((it) => it.id === x.id);
                return (
                  <div key={x.id} className="inc-node ev-click" onClick={() => onOpen(x.id, x.since)}>
                    <span className={"dot " + (x.until == null ? st : "ok")} />
                    <span style={{ flex: 1, minWidth: 0 }}>{x.name} <small className="c-muted num">{x.host}</small></span>
                    <small className="c-muted">{x.until == null ? x.problem : `${t("вернулся")} ${fmtTime(x.until, false)}`}</small>
                    {live && x.until == null && <small className="num c-muted">{live.lastRtt == null ? "✕" : `${live.lastRtt.toFixed(0)} мс`}</small>}
                  </div>
                );
              })}
              <div className="inc-h" style={{ marginTop: 12 }}>{t("Хронология")}</div>
              <div className="inc-log">
                {i.log.map((l, k) => (
                  <div key={k} className="inc-log-row"><span className="num c-muted">{fmtDateTime(l.ts)}</span><span>{l.text}</span></div>
                ))}
              </div>
              {control && <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input className="input" placeholder={t("Заметка: что сделали, что сказал оператор")} value={note} onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && note.trim()) { act(api.incidentNote(i.id, note), t("Заметка добавлена")); setNote(""); } }} />
                <button className="btn sm" disabled={!note.trim()} onClick={() => { act(api.incidentNote(i.id, note), t("Заметка добавлена")); setNote(""); }}>{t("Добавить")}</button>
              </div>}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="inc-h">{t("Кому звонить")}</div>
              {ops === null ? <div className="c-muted">{t("Загружаю…")}</div> : (
                <OperatorCard list={ops} compact onTicket={control ? (op) => onTicket(op) : undefined} onManage={() => onOperators(firstId)} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
