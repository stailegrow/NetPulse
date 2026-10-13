import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { t } from "../i18n";
import type { Incident, Operator, TargetOperator, TicketDraft } from "../types";
import { operatorKindLabel } from "../types";
import { Icon } from "./ui";
import { useIncidentControl } from "../control";

/** Копирование в буфер с подтверждением на кнопке. */
export function CopyBtn({ text, label = "Копировать", className = "btn sm" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className={className} type="button" onClick={(e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }).catch(() => {});
    }}>{done ? t("Скопировано") : t(label)}</button>
  );
}

const initials = (name: string) => name.split(/[\s\-«»"]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

export function OperatorAvatar({ op, size = 40 }: { op: Operator; size?: number }) {
  return <span className="op-ava" style={{ width: size, height: size, fontSize: size * 0.36 }}>{initials(op.name)}</span>;
}

/** Карточка «кому звонить» — на странице цели и в инциденте. */
export function OperatorCard({ list, onTicket, onManage, compact }: {
  list: TargetOperator[];
  onTicket?: (operatorId: string) => void;
  onManage?: () => void;
  compact?: boolean;
}) {
  const [i, setI] = useState(0);
  if (!list.length) {
    return (
      <div className="op-card op-empty">
        <div className="op-empty-t">{t("Оператор не назначен")}</div>
        <div className="c-muted" style={{ fontSize: 12.5 }}>{t("Укажите, кто обслуживает этот узел, — здесь появятся телефоны, номер услуги и готовая заявка.")}</div>
        {onManage && <button className="btn sm" onClick={onManage}>{t("Назначить оператора")}</button>}
      </div>
    );
  }
  const cur = list[Math.min(i, list.length - 1)];
  const op = cur.operator;
  const sv = cur.service;
  return (
    <div className="op-card">
      {list.length > 1 && (
        <div className="chips op-tabs">
          {list.map((x, k) => (
            <button key={x.operator.id + (x.service?.id ?? k)} className={k === i ? "on" : ""} onClick={() => setI(k)}>
              {x.operator.name}{x.service?.role === "backup" ? ` · ${t("резерв")}` : ""}
            </button>
          ))}
        </div>
      )}
      <div className="op-head">
        <OperatorAvatar op={op} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="op-name">{op.name}</div>
          <div className="c-muted" style={{ fontSize: 12 }}>
            {t(operatorKindLabel(op.kind))}
            {sv ? ` · ${sv.role === "backup" ? t("резервный") : t("основной")}` : ""}
            {cur.via === "group" ? ` · ${t("по группе")}` : cur.via === "hint" ? ` · ${t("подсказка по трассировке")}` : ""}
          </div>
        </div>
      </div>
      {(sv?.number || op.contract || sv?.address || op.slaReactMin > 0) && (
        <dl className="op-kv">
          {sv?.number && <><dt>{t("Услуга")}</dt><dd className="num">{sv.number}</dd></>}
          {op.contract && <><dt>{t("Договор")}</dt><dd className="num">{op.contract}{op.account ? `, л/с ${op.account}` : ""}</dd></>}
          {sv?.address && <><dt>{t("Адрес")}</dt><dd>{sv.address}</dd></>}
          {!compact && sv?.ips && <><dt>IP</dt><dd className="num">{sv.ips}</dd></>}
          {(op.slaReactMin > 0 || op.slaFixHours > 0) && (
            <><dt>SLA</dt><dd>{[op.slaReactMin > 0 ? `${t("реакция")} ${op.slaReactMin} ${t("мин")}` : "", op.slaFixHours > 0 ? `${t("восстановление")} ${op.slaFixHours} ${t("ч")}` : ""].filter(Boolean).join(", ")}</dd></>
          )}
        </dl>
      )}
      <div className="op-contacts">
        {op.phones.map((p, k) => (
          <div className="op-contact" key={"p" + k}>
            <div style={{ minWidth: 0 }}>
              <b className="num">{p.value}</b>
              {p.label && <small>{p.label}</small>}
            </div>
            <button className="btn sm ghost" onClick={() => api.openLink("tel:" + p.value.replace(/[^\d+]/g, ""))} title={t("Позвонить")}><Icon name="phone" size={13} /></button>
            <CopyBtn text={p.value} />
          </div>
        ))}
        {op.emails.map((m, k) => (
          <div className="op-contact" key={"e" + k}>
            <div style={{ minWidth: 0 }}>
              <b className="num">{m.value}</b>
              {m.label && <small>{m.label}</small>}
            </div>
            <CopyBtn text={m.value} />
          </div>
        ))}
        {op.portal && (
          <div className="op-contact">
            <div style={{ minWidth: 0 }}><b className="num" style={{ fontSize: 12.5 }}>{op.portal.replace(/^https?:\/\//, "")}</b><small>{t("Личный кабинет")}</small></div>
            <button className="btn sm" onClick={() => api.openLink(op.portal.startsWith("http") ? op.portal : "https://" + op.portal)}>{t("Открыть")}</button>
          </div>
        )}
      </div>
      {!compact && op.escalation && <div className="op-note"><b>{t("Эскалация")}:</b> {op.escalation}</div>}
      {!compact && op.notes && <div className="op-note">{op.notes}</div>}
      {onTicket && <button className="btn primary sm" style={{ justifySelf: "start" }} onClick={() => onTicket(op.id)}>{t("Подготовить заявку")}</button>}
    </div>
  );
}

/** Окно заявки оператору: готовый текст, копирование, письмо, отметка обращения. */
export function TicketModal({ incident, targetId, operatorId, onClose, onSaved, toast }: {
  incident?: Incident | null;
  targetId?: string | null;
  operatorId?: string | null;
  onClose: () => void;
  onSaved?: (i: Incident) => void;
  toast: (m: string, k?: string) => void;
}) {
  const [ops, setOps] = useState<TargetOperator[]>([]);
  const [opId, setOpId] = useState<string | null>(operatorId ?? null);
  const [draft, setDraft] = useState<TicketDraft | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [number, setNumber] = useState(incident?.ticket?.number ?? "");
  const tid = targetId ?? incident?.targets[0]?.id ?? null;
  const control = useIncidentControl();

  useEffect(() => {
    if (tid) api.targetOperators(tid).then(setOps).catch(() => {});
  }, [tid]);
  useEffect(() => {
    api.ticketDraft({ incidentId: incident?.id, targetId: tid, operatorId: opId })
      .then((d) => { setDraft(d); setSubject(d.subject); setBody(d.body); if (!opId && d.operatorId) setOpId(d.operatorId); })
      .catch((e) => toast(String(e), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incident?.id, tid, opId]);

  const full = `${t("Тема")}: ${subject}\n\n${body}`;
  const mail = () => {
    const to = draft?.to ?? "";
    api.openLink(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`).catch((e) => toast(String(e), "error"));
  };
  const mark = async () => {
    if (!incident) return;
    try {
      const i = await api.incidentTicket(incident.id, opId ?? "", number);
      toast(t("Обращение отмечено в инциденте"), "ok");
      onSaved?.(i);
      onClose();
    } catch (e) { toast(String(e), "error"); }
  };

  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-fixed" style={{ width: "min(720px, calc(100vw - 40px))", height: "min(760px, calc(100vh - 60px))" }}>
        <div className="modal-h">
          <h2>{t("Заявка оператору")}</h2>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal-b" style={{ display: "grid", gap: 12, alignContent: "start" }}>
          {ops.length > 1 && (
            <div className="chips">
              {ops.map((o) => (
                <button key={o.operator.id + (o.service?.id ?? "")} className={opId === o.operator.id ? "on" : ""} onClick={() => setOpId(o.operator.id)}>
                  {o.operator.name}{o.service?.role === "backup" ? ` · ${t("резерв")}` : ""}
                </button>
              ))}
            </div>
          )}
          {!ops.length && <div className="banner" style={{ margin: 0 }}>{t("У этого узла не указан оператор: текст заявки без номера услуги и договора. Назначить оператора можно в разделе «Операторы».")}</div>}
          {draft?.to && (
            <div className="row-line">
              <span className="c-muted">{t("Кому")}:</span> <b className="num">{draft.to}</b>
              <CopyBtn text={draft.to} />
            </div>
          )}
          <label className="field">
            <span>{t("Тема")}</span>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("Текст")}</span>
            <textarea className="textarea ticket-text" value={body} onChange={(e) => setBody(e.target.value)} rows={16} />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <CopyBtn text={full} label="Копировать заявку" className="btn" />
            <button className="btn" onClick={mail}>{t("Открыть письмо")}</button>
          </div>
          {incident && control && (
            <div className="card" style={{ margin: 0 }}>
              <h3 style={{ fontSize: 13.5 }}>{t("Отметить обращение")}</h3>
              <div className="desc">{t("Запишем в инцидент, кто и когда обратился и номер заявки у оператора. Инцидент станет «взятым в работу».")}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input className="input" placeholder={t("Номер заявки у оператора (если дали)")} value={number} onChange={(e) => setNumber(e.target.value)} />
                <button className="btn primary" onClick={mark}>{t("Отметить")}</button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-f">
          <button className="btn ghost" onClick={onClose}>{t("Закрыть")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
