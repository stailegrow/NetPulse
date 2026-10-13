import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { t } from "../i18n";
import { fmtDateTime, plural } from "../format";
import type { Contact, Incident, Operator, OperatorKind, OperatorService, TargetSummary } from "../types";
import { emptyOperator, isBuiltinKind, operatorKindLabel, OPERATOR_KIND } from "../types";
import { ask } from "../components/Dialogs";
import { OperatorAvatar } from "../components/OperatorCard";
import { Dot } from "../components/ui";
import { fmtDuration } from "./Reports";

const newService = (targets: string[] = []): OperatorService => ({ id: "", number: "", address: "", ips: "", speed: "", note: "", role: "primary", targets, groups: [] });

/** Цели, которые обслуживает оператор (через услуги, по целям и группам). */
export function operatorTargets(op: Operator, items: TargetSummary[]): TargetSummary[] {
  const ids = new Set(op.services.flatMap((s) => s.targets));
  const gs = new Set(op.services.flatMap((s) => s.groups));
  return items.filter((i) => ids.has(i.id) || gs.has(i.group));
}

export function Operators({ items, groups, toast, onOpen, focusTarget, onFocusDone }: {
  items: TargetSummary[];
  groups: string[];
  toast: (m: string, k?: string) => void;
  onOpen: (id: string, at?: number) => void;
  focusTarget?: string | null;
  onFocusDone?: () => void;
}) {
  const [list, setList] = useState<Operator[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Operator | null>(null);
  const [orig, setOrig] = useState("");
  const [q, setQ] = useState("");
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const focus = focusTarget ? items.find((i) => i.id === focusTarget) ?? null : null;

  const load = () => api.operators().then((l) => { setList(l); return l; }).catch(() => { setList([]); return [] as Operator[]; });
  useEffect(() => {
    load().then((l) => { if (!sel && l.length && !focusTarget) pick(l[0]); });
    api.incidents(Date.now() - 30 * 86400e3, Date.now(), 2000).then(setIncidents).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (op: Operator) => {
    setSel(op.id);
    const d = structuredClone(op);
    setDraft(d);
    setOrig(JSON.stringify(d));
  };
  const create = () => {
    const d = emptyOperator();
    d.services = [newService(focus ? [focus.id] : [])];
    setSel("new");
    setDraft(d);
    setOrig("");
  };
  const dirty = draft != null && JSON.stringify(draft) !== orig;
  const set = (patch: Partial<Operator>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = async () => {
    if (!draft) return;
    try {
      const op = await api.saveOperator(draft);
      toast(t("Оператор сохранён"), "ok");
      await load();
      pick(op);
      if (focus && op.services.some((s) => s.targets.includes(focus.id))) onFocusDone?.();
    } catch (e) { toast(String(e), "error"); }
  };
  const revert = () => {
    if (sel === "new" || !draft?.id) { setDraft(null); setSel(null); if (list?.length) pick(list[0]); return; }
    const op = list?.find((o) => o.id === draft.id);
    if (op) pick(op);
  };
  const remove = async () => {
    if (!draft?.id) { setDraft(null); setSel(null); return; }
    if (!(await ask({ title: `Удалить «${draft.name}»?`, message: "Карточка оператора и его услуги будут удалены. Цели и история не изменятся.", confirm: "Удалить", danger: true }))) return;
    await api.deleteOperator(draft.id).catch((e) => toast(String(e), "error"));
    setDraft(null);
    setSel(null);
    load();
  };
  const addFocusTo = (op: Operator) => {
    const d = structuredClone(op);
    if (d.services.length) d.services[0].targets = [...new Set([...d.services[0].targets, focus!.id])];
    else d.services.push(newService([focus!.id]));
    setSel(op.id);
    setDraft(d);
    setOrig(JSON.stringify(op));
  };

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list ?? []).filter((o) => !s || o.name.toLowerCase().includes(s) || o.services.some((x) => x.number.toLowerCase().includes(s) || x.address.toLowerCase().includes(s)));
  }, [list, q]);

  const statsOf = (op: Operator) => {
    const ids = new Set(operatorTargets(op, items).map((x) => x.id));
    const inc = incidents.filter((i) => i.targets.some((x) => ids.has(x.id)));
    const down = inc.reduce((a, i) => a + ((i.closed ?? Date.now()) - i.opened), 0);
    return { targets: ids.size, inc, down };
  };

  return (
    <div className="ops">
      <aside className="ops-list">
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input" placeholder={t("Поиск: оператор, услуга, адрес")} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" onClick={create}>+ {t("Оператор")}</button>
        </div>
        {focus && (
          <div className="banner info-banner">
            {t("Выберите оператора для")} «<b>{focus.name}</b>» {t("или создайте нового — цель добавится в его услугу.")}
            <button className="btn ghost sm" onClick={onFocusDone}>{t("Отмена")}</button>
          </div>
        )}
        {list === null && <div className="c-muted">{t("Загружаю…")}</div>}
        {list?.length === 0 && sel !== "new" && (
          <div className="ops-empty">
            <b>{t("Справочник пуст")}</b>
            <span>{t("Добавьте провайдеров, ЦОД и подрядчиков: телефоны поддержки, номера договоров и услуг. Они появятся в инцидентах, в Телеграме и на странице цели.")}</span>
          </div>
        )}
        {sel === "new" && draft && (
          <button className="ops-row on">
            <OperatorAvatar op={draft} size={34} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <b>{draft.name.trim() || t("Новый оператор")}</b>
              <small className="c-warn">{t("ещё не сохранён")}</small>
            </span>
          </button>
        )}
        {shown.map((op) => {
          const st = statsOf(op);
          return (
            <button key={op.id} className={"ops-row" + (sel === op.id ? " on" : "")} onClick={() => (focus ? addFocusTo(op) : pick(op))}>
              <OperatorAvatar op={op} size={34} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <b>{op.name}</b>
                <small>{t(operatorKindLabel(op.kind))} · {plural(st.targets, "цель", "цели", "целей")}{st.inc.length ? ` · ${plural(st.inc.length, "инцидент", "инцидента", "инцидентов")} за 30 дн.` : ""}</small>
              </span>
              {focus && <span className="btn sm">{t("Выбрать")}</span>}
            </button>
          );
        })}
      </aside>

      <section className="ops-edit">
        {!draft ? (
          <div className="empty"><h2>{t("Операторы")}</h2><div>{t("Выберите оператора слева или добавьте нового.")}</div></div>
        ) : (
          <>
            <div className="ops-edit-h">
              <OperatorAvatar op={draft} size={44} />
              <input className="input ops-name" placeholder={t("Название: провайдер, ЦОД, подрядчик")} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
              <KindPicker value={draft.kind} custom={[...new Set((list ?? []).map((o) => o.kind).filter((k) => k && !isBuiltinKind(k)))]} onChange={(kind) => set({ kind })} />
            </div>

            {draft.id && (() => {
              const st = statsOf(draft);
              return (
                <div className="stats-row" style={{ padding: 0 }}>
                  <div className="stat-card"><div className="v">{st.targets}</div><div className="l">{t("целей обслуживает")}</div></div>
                  <div className="stat-card"><div className="v">{st.inc.length}</div><div className="l">{t("инцидентов за 30 дней")}</div></div>
                  <div className="stat-card"><div className="v">{fmtDuration(st.down)}</div><div className="l">{t("простой за 30 дней")}</div></div>
                </div>
              );
            })()}

            <div className="card">
              <h3>{t("Как связаться")}</h3>
              <ContactList title={t("Телефоны")} list={draft.phones} placeholder={t("Номер телефона")} labelHint={t("Кто отвечает и когда: техподдержка 24/7, менеджер…")} onChange={(phones) => set({ phones })} />
              <ContactList title={t("Почта для заявок")} list={draft.emails} placeholder={t("Адрес почты")} labelHint={t("Для чего: заявки, бухгалтерия…")} onChange={(emails) => set({ emails })} />
              <div className="form-grid" style={{ marginTop: 12 }}>
                <label className="field"><span>{t("Личный кабинет / портал")}</span><input className="input" value={draft.portal} placeholder={t("Ссылка на личный кабинет")} onChange={(e) => set({ portal: e.target.value })} /></label>
                <label className="field"><span>Telegram</span><input className="input" value={draft.telegram} placeholder={t("@логин или ссылка на чат")} onChange={(e) => set({ telegram: e.target.value })} /></label>
                <label className="field full"><span>{t("Эскалация")}</span><input className="input" value={draft.escalation} placeholder={t("Кому звонить, если поддержка не отвечает, и через сколько")} onChange={(e) => set({ escalation: e.target.value })} /></label>
              </div>
            </div>

            <div className="card">
              <h3>{t("Договор и SLA")}</h3>
              <div className="form-grid three" style={{ marginTop: 10 }}>
                <label className="field"><span>{t("Номер договора")}</span><input className="input" value={draft.contract} onChange={(e) => set({ contract: e.target.value })} /></label>
                <label className="field"><span>{t("Лицевой счёт")}</span><input className="input" value={draft.account} onChange={(e) => set({ account: e.target.value })} /></label>
                <label className="field"><span>{t("Доступность по договору, %")}</span><input className="input num" type="number" step="0.01" value={draft.slaUptime || ""} placeholder={t("не указано")} onChange={(e) => set({ slaUptime: Number(e.target.value) || 0 })} /></label>
                <label className="field"><span>{t("Реакция, мин")}</span><input className="input num" type="number" value={draft.slaReactMin || ""} placeholder={t("не указано")} onChange={(e) => set({ slaReactMin: Number(e.target.value) || 0 })} /></label>
                <label className="field"><span>{t("Восстановление, ч")}</span><input className="input num" type="number" step="0.5" value={draft.slaFixHours || ""} placeholder={t("не указано")} onChange={(e) => set({ slaFixHours: Number(e.target.value) || 0 })} /></label>
                <label className="field"><span>{t("Узнавать в трассировке")}</span><input className="input" value={draft.domains} placeholder={t("Домены через запятую")} onChange={(e) => set({ domains: e.target.value })} /><small className="hint">{t("домены в именах хопов — для подсказки")}</small></label>
                <label className="field full"><span>{t("Заметки")}</span><input className="input" value={draft.notes} placeholder={t("Что важно знать при обращении")} onChange={(e) => set({ notes: e.target.value })} /></label>
              </div>
            </div>

            <div className="card">
              <div className="section-title" style={{ marginBottom: 4 }}>
                {t("Услуги")}
                <span className="sub">{t("номер, который называют в заявке, и какие узлы через него работают")}</span>
                <span style={{ flex: 1 }} />
                <button className="btn sm" onClick={() => set({ services: [...draft.services, newService()] })}>+ {t("Услуга")}</button>
              </div>
              {!draft.services.length && <div className="c-muted" style={{ fontSize: 12.5 }}>{t("Пока нет услуг. Без них оператор не привязан ни к одному узлу.")}</div>}
              {draft.services.map((sv, k) => (
                <ServiceEditor key={sv.id || k} n={k + 1} sv={sv} items={items} groups={groups}
                  onChange={(s2) => set({ services: draft.services.map((x, j) => (j === k ? s2 : x)) })}
                  onRemove={() => set({ services: draft.services.filter((_, j) => j !== k) })} />
              ))}
            </div>

            {draft.id && (() => {
              const st = statsOf(draft);
              if (!st.inc.length) return null;
              return (
                <div className="card">
                  <h3>{t("Последние инциденты")}</h3>
                  {st.inc.slice(0, 8).map((i) => (
                    <div key={i.id} className="ops-inc" onClick={() => i.targets[0] && onOpen(i.targets[0].id, i.opened)}>
                      <span className={"dot " + (i.closed ? "ok" : i.severity === "critical" ? "down" : "warn")} />
                      <span style={{ flex: 1, minWidth: 0 }}>{i.title}</span>
                      <span className="c-muted num">{fmtDateTime(i.opened)}</span>
                      <span className="num">{fmtDuration((i.closed ?? Date.now()) - i.opened)}</span>
                      {i.ticket?.number && <span className="ttag">№ {i.ticket.number}</span>}
                    </div>
                  ))}
                </div>
              );
            })()}

            <div className="ops-bar">
              <button className="btn primary" disabled={!dirty || !draft.name.trim()} onClick={save}>{draft.id ? t("Сохранить") : t("Создать оператора")}</button>
              {(dirty || !draft.id) && <button className="btn" onClick={revert}>{draft.id ? t("Отменить изменения") : t("Отмена")}</button>}
              <span className="ops-bar-st">
                {!draft.name.trim() ? <span className="c-muted">{t("Укажите название")}</span> : dirty ? <span className="c-warn">● {t("Есть несохранённые изменения")}</span> : <span className="c-muted">{t("Все изменения сохранены")}</span>}
              </span>
              {draft.id && <button className="btn ghost danger" onClick={remove}>{t("Удалить оператора")}</button>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ContactList({ title, list, placeholder, labelHint, onChange }: { title: string; list: Contact[]; placeholder: string; labelHint: string; onChange: (l: Contact[]) => void }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="field"><span>{title}</span></div>
      <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
        {list.map((c, k) => (
          <div key={k} style={{ display: "flex", gap: 6 }}>
            <input className="input num" style={{ flex: "1 1 40%" }} placeholder={placeholder} value={c.value} onChange={(e) => onChange(list.map((x, j) => (j === k ? { ...x, value: e.target.value } : x)))} />
            <input className="input" style={{ flex: "1 1 60%" }} placeholder={labelHint} value={c.label} onChange={(e) => onChange(list.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)))} />
            <button className="btn ghost sm" onClick={() => onChange(list.filter((_, j) => j !== k))} title={t("Убрать")}>✕</button>
          </div>
        ))}
        <button className="btn ghost sm" style={{ justifySelf: "start" }} onClick={() => onChange([...list, { value: "", label: "" }])}>+ {t("Добавить")}</button>
      </div>
    </div>
  );
}

function ServiceEditor({ sv, n, items, groups, onChange, onRemove }: { sv: OperatorService; n: number; items: TargetSummary[]; groups: string[]; onChange: (s: OperatorService) => void; onRemove: () => void }) {
  const [q, setQ] = useState("");
  const [picker, setPicker] = useState(false);
  const set = (p: Partial<OperatorService>) => onChange({ ...sv, ...p });
  const byGroup = new Set(items.filter((i) => sv.groups.includes(i.group)).map((i) => i.id));
  const found = q.trim() ? items.filter((i) => !sv.targets.includes(i.id) && !byGroup.has(i.id) && (i.name.toLowerCase().includes(q.toLowerCase()) || i.host.includes(q))).slice(0, 8) : [];
  const realGroups = groups.filter((g) => items.some((i) => i.group === g));
  const total = new Set([...byGroup, ...sv.targets]).size;
  return (
    <div className="svc">
      <div className="svc-h">
        <b>{t("Услуга")} {n}</b>
        <span className="c-muted">{total ? `${plural(total, "узел", "узла", "узлов")}` : t("узлы не выбраны")}</span>
        <span style={{ flex: 1 }} />
        <select className="select sm" value={sv.role} onChange={(e) => set({ role: e.target.value as OperatorService["role"] })}>
          <option value="primary">{t("Основной канал")}</option>
          <option value="backup">{t("Резервный канал")}</option>
        </select>
        <button className="btn ghost sm danger" onClick={onRemove}>{t("Убрать")}</button>
      </div>
      <div className="form-grid four">
        <label className="field"><span>{t("Номер услуги / канала")}</span><input className="input num" value={sv.number} placeholder={t("как в договоре")} onChange={(e) => set({ number: e.target.value })} /></label>
        <label className="field"><span>{t("Адрес подключения")}</span><input className="input" value={sv.address} onChange={(e) => set({ address: e.target.value })} /></label>
        <label className="field"><span>{t("IP-адреса")}</span><input className="input num" value={sv.ips} onChange={(e) => set({ ips: e.target.value })} /></label>
        <label className="field"><span>{t("Скорость, заметка")}</span><input className="input" value={sv.note} onChange={(e) => set({ note: e.target.value })} /></label>
      </div>
      <div className="svc-sec">
        <div className="svc-lab">{t("Группы целиком")} <small>{t("все узлы группы, включая новые")}</small></div>
        <div className="svc-chips">
          {realGroups.map((g) => (
            <button key={g} className={"chip-tg" + (sv.groups.includes(g) ? " on" : "")} onClick={() => set({ groups: sv.groups.includes(g) ? sv.groups.filter((x) => x !== g) : [...sv.groups, g] })}>
              {sv.groups.includes(g) && "✓ "}{g} <small>{items.filter((i) => i.group === g).length}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="svc-sec">
        <div className="svc-lab">{t("Отдельные узлы")} <small>{t("если услуга нужна не всей группе")}</small></div>
        <div className="svc-pick">
          <span className="svc-add">
            <input className="input" placeholder={t("Найти узел по имени или адресу")} value={q} onChange={(e) => setQ(e.target.value)} />
            {found.length > 0 && (
              <span className="svc-found">
                {found.map((i) => (
                  <button key={i.id} onClick={() => { set({ targets: [...sv.targets, i.id] }); setQ(""); }}>
                    <Dot h={i.health} /> {i.name} <small className="num">{i.host}</small> <small>{i.group}</small>
                  </button>
                ))}
              </span>
            )}
          </span>
          <button className="btn" onClick={() => setPicker(true)}>＋ {t("Выбрать из списка")}</button>
        </div>
        {sv.targets.length > 0 && (
          <div className="svc-chips">
            {sv.targets.map((id) => {
              const it = items.find((i) => i.id === id);
              return (
                <span key={id} className="chip-tg on">
                  {it && <Dot h={it.health} />} {it?.name ?? t("удалённая цель")}
                  <button onClick={() => set({ targets: sv.targets.filter((x) => x !== id) })} title={t("Убрать")}>✕</button>
                </span>
              );
            })}
            {sv.targets.length > 1 && <button className="btn ghost sm" onClick={() => set({ targets: [] })}>{t("Убрать все")}</button>}
          </div>
        )}
      </div>
      {picker && (
        <TargetPicker
          items={items}
          groups={realGroups}
          selected={sv.targets}
          locked={byGroup}
          onClose={() => setPicker(false)}
          onDone={(ids) => { set({ targets: ids }); setPicker(false); }}
        />
      )}
    </div>
  );
}

/** Выбор узлов из списка программы: поиск, фильтр по группе, галочки. */
function TargetPicker({ items, groups, selected, locked, onClose, onDone }: {
  items: TargetSummary[];
  groups: string[];
  selected: string[];
  locked: Set<string>;
  onClose: () => void;
  onDone: (ids: string[]) => void;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set(selected));
  const [q, setQ] = useState("");
  const [g, setG] = useState<string | null>(null);
  const list = items.filter((i) => (!g || i.group === g) && (!q.trim() || i.name.toLowerCase().includes(q.toLowerCase()) || i.host.toLowerCase().includes(q.toLowerCase())));
  const free = list.filter((i) => !locked.has(i.id));
  const allOn = free.length > 0 && free.every((i) => sel.has(i.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-fixed" style={{ width: "min(720px, calc(100vw - 40px))", height: "min(720px, calc(100vh - 60px))" }}>
        <div className="modal-h">
          <h2>{t("Узлы для услуги")}</h2>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <div className="tp-tools">
          <input className="input" autoFocus placeholder={t("Поиск по имени или адресу")} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chips tp-groups">
            <button className={!g ? "on" : ""} onClick={() => setG(null)}>{t("Все")} <small>{items.length}</small></button>
            {groups.map((x) => <button key={x} className={g === x ? "on" : ""} onClick={() => setG(g === x ? null : x)}>{x} <small>{items.filter((i) => i.group === x).length}</small></button>)}
          </div>
        </div>
        <div className="modal-b tp-list">
          <label className="tp-row tp-all">
            <input type="checkbox" checked={allOn} disabled={!free.length} onChange={() => setSel((s) => { const n = new Set(s); free.forEach((i) => (allOn ? n.delete(i.id) : n.add(i.id))); return n; })} />
            <span>{allOn ? t("Снять все показанные") : t("Выбрать все показанные")} <small className="c-muted">({free.length})</small></span>
          </label>
          {list.length === 0 && <div className="c-muted" style={{ padding: 16 }}>{t("Ничего не найдено")}</div>}
          {list.map((i) => {
            const lock = locked.has(i.id);
            return (
              <label key={i.id} className={"tp-row" + (lock ? " lock" : "")}>
                <input type="checkbox" checked={lock || sel.has(i.id)} disabled={lock} onChange={() => toggle(i.id)} />
                <Dot h={i.health} />
                <span className="tp-name">{i.name}</span>
                <span className="num c-muted tp-host">{i.host}</span>
                <span className="c-muted tp-grp">{lock ? t("уже по группе") : i.group}</span>
              </label>
            );
          })}
        </div>
        <div className="modal-f">
          <span className="c-muted" style={{ marginRight: "auto" }}>{t("Выбрано")}: <b className="num">{sel.size}</b></span>
          <button className="btn" onClick={onClose}>{t("Отмена")}</button>
          <button className="btn primary" onClick={() => onDone([...sel].filter((id) => !locked.has(id)))}>{t("Готово")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Тип оператора: встроенные варианты, уже введённые свои и «Своё название…». */
function KindPicker({ value, custom, onChange }: { value: OperatorKind; custom: string[]; onChange: (k: OperatorKind) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const own = [...new Set([...custom, ...(value && !isBuiltinKind(value) ? [value] : [])])].sort((a, b) => a.localeCompare(b, "ru"));
  if (editing) {
    const done = () => { const v = text.trim(); if (v) onChange(v); setEditing(false); };
    return (
      <span className="kind-edit">
        <input className="input" autoFocus placeholder={t("Например: Площадка, Офис")} value={text} maxLength={40}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") done(); if (e.key === "Escape") setEditing(false); }} />
        <button className="btn primary sm" disabled={!text.trim()} onClick={done}>{t("OK")}</button>
        <button className="btn ghost sm" onClick={() => setEditing(false)}>✕</button>
      </span>
    );
  }
  return (
    <select className="select" style={{ width: 170 }} value={value} onChange={(e) => {
      if (e.target.value === "\u0000custom") { setText(isBuiltinKind(value) ? "" : value); setEditing(true); } else onChange(e.target.value);
    }}>
      {Object.entries(OPERATOR_KIND).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
      {own.length > 0 && <option disabled>──────────</option>}
      {own.map((k) => <option key={k} value={k}>{operatorKindLabel(k)}</option>)}
      <option value={"\u0000custom"}>{t("Своё название…")}</option>
    </select>
  );
}
