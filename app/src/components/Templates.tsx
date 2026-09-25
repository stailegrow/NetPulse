import { t as tx } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import type { Target, TargetTemplate } from "../types";
import { fmtInterval } from "../format";
import { Field, NumInput, ThresholdFields, Toggle } from "./ui";

export const INTERVALS = [1000, 2500, 5000, 10000, 15000, 30000, 60000, 300000];

/** Краткое описание шаблона: «40/70/100 мс · потери 2/5 % · VoIP». */
export function templateSummary(t: TargetTemplate) {
  const th = t.thresholds;
  const voip = th.jitterCrit > 0 || th.mosCrit > 0 ? " · VoIP" : "";
  return `${fmtInterval(t.intervalMs)} · ${th.warnMs}/${th.badMs}/${th.critMs} мс · потери ${th.warnLoss}/${th.badLoss} %${voip}${t.alertsEnabled ? "" : " · тишина"}`;
}

/** Привязать цель к шаблону: интервал, таймаут, пороги, уведомления берутся из него. */
export function applyTemplate(t: Target, tpl: TargetTemplate): Target {
  return { ...t, templateId: tpl.id, intervalMs: tpl.intervalMs, timeoutMs: tpl.timeoutMs, thresholds: { ...tpl.thresholds }, alertsEnabled: tpl.alertsEnabled };
}

/** Окно создания и редактирования шаблона: настройки + к каким группам и узлам он привязан. */
export function TemplateEditor({ initial, targets, groups, templates, onSave, onClose }: {
  initial: TargetTemplate;
  targets: Target[];
  groups: string[];
  templates: TargetTemplate[];
  onSave: (t: TargetTemplate, ids: string[]) => void;
  onClose: () => void;
}) {
  const [t, setT] = useState<TargetTemplate>({ ...initial, groups: initial.groups ?? [] });
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(() => new Set(targets.filter((x) => x.templateId === initial.id).map((x) => x.id)));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tplName = (id: string | null) => templates.find((x) => x.id === id)?.name;
  const byGroup = useMemo(() => {
    const names = [...groups];
    for (const x of targets) if (!names.includes(x.group)) names.push(x.group);
    const ql = q.trim().toLowerCase();
    return names
      .map((g) => ({ g, list: targets.filter((x) => x.group === g) }))
      .map(({ g, list }) => ({ g, all: list, list: ql ? list.filter((x) => `${x.name} ${x.host} ${g}`.toLowerCase().includes(ql)) : list }))
      .filter((x) => !ql || x.list.length || x.g.toLowerCase().includes(ql));
  }, [groups, targets, q]);

  const setGroup = (g: string, list: Target[], on: boolean) => {
    setSel((cur) => {
      const n = new Set(cur);
      list.forEach((x) => (on ? n.add(x.id) : n.delete(x.id)));
      return n;
    });
    setT((x) => ({ ...x, groups: on ? [...new Set([...x.groups, g])] : x.groups.filter((z) => z !== g) }));
  };
  const setNode = (x: Target, on: boolean) => {
    setSel((cur) => {
      const n = new Set(cur);
      if (on) n.add(x.id); else n.delete(x.id);
      return n;
    });
    // Сняли узел — группа уже не «целиком», новые узлы в ней шаблон не получат.
    if (!on) setT((z) => ({ ...z, groups: z.groups.filter((g) => g !== x.group) }));
  };
  const ownerOf = (g: string) => templates.find((x) => x.id !== initial.id && (x.groups ?? []).includes(g))?.name;

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(780px, calc(100vw - 40px))" }}>
        <div className="modal-h"><h2>{initial.name ? `Шаблон: ${initial.name}` : "Новый шаблон"}</h2></div>
        <div className="modal-b">
          <div className="form-grid">
            <Field label={tx("Название")}>
              <input className="input" autoFocus value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder={tx("Например: VPN-туннели")} />
            </Field>
            <Field label={tx("Интервал проверки")}>
              <select className="select" value={t.intervalMs} onChange={(e) => setT({ ...t, intervalMs: Number(e.target.value) })}>
                {[...new Set([...INTERVALS, t.intervalMs])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{fmtInterval(v)}</option>)}
              </select>
            </Field>
            <Field label={tx("Таймаут, мс")}>
              <NumInput value={t.timeoutMs} min={200} max={60000} step={100} onChange={(v) => setT({ ...t, timeoutMs: v })} />
            </Field>
            <div className="field" style={{ alignContent: "end" }}>
              <Toggle checked={t.alertsEnabled} onChange={(v) => setT({ ...t, alertsEnabled: v })} label={tx("Уведомления")} />
            </div>
          </div>
          <div className="sep" />
          <div className="section-title" style={{ marginBottom: 10 }}>{tx("Пороги")}</div>
          <ThresholdFields value={t.thresholds} onChange={(v) => setT({ ...t, thresholds: v })} voip />

          <div className="sep" />
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
            <div className="section-title">{tx("Где применяется")}</div>
            <span style={{ flex: 1 }} />
            <span className={sel.size ? "c-ok" : "c-warn"} style={{ fontSize: 12.5 }}>
              {sel.size ? `привязано узлов: ${sel.size}` : "ни к одному узлу не привязан"}
              {t.groups.length > 0 && <span className="c-muted"> · группы: {t.groups.join(", ")}</span>}
            </span>
          </div>
          <div className="c-muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Отмеченные узлы берут интервал, таймаут, пороги и уведомления из шаблона — поменяли шаблон, поменялись все они.
            Группа, отмеченная целиком, закрепляется за шаблоном: новые узлы в ней и перенесённые в неё получают его сами.
          </div>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx("Найти узел или группу…")} style={{ marginBottom: 8 }} />
          <div className="tpl-apply">
            {byGroup.map(({ g, all, list }) => {
              const cnt = all.filter((x) => sel.has(x.id)).length;
              const full = t.groups.includes(g) || (all.length > 0 && cnt === all.length);
              const part = !full && cnt > 0;
              const isOpen = open.has(g) || !!q.trim();
              const owner = ownerOf(g);
              return (
                <div key={g} className="ta-group">
                  <div className="ta-row ta-g">
                    <button className={"ta-arrow" + (isOpen ? " open" : "")} disabled={!all.length} onClick={() => setOpen((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; })}>▸</button>
                    <input type="checkbox" checked={full} ref={(el) => { if (el) el.indeterminate = part; }} onChange={(e) => setGroup(g, all, e.target.checked)} />
                    <span className="nm" onClick={() => all.length && setOpen((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; })}>{g}</span>
                    <span className="c-muted num">{all.length ? `${cnt} из ${all.length}` : "пустая"}</span>
                    {t.groups.includes(g) && <span className="ttag ok">{tx("вся группа, включая новые")}</span>}
                    {!t.groups.includes(g) && owner && <span className="ttag">закреплена за «{owner}»</span>}
                  </div>
                  {isOpen && list.map((x) => {
                    const other = x.templateId && x.templateId !== initial.id ? tplName(x.templateId) : null;
                    return (
                      <label key={x.id} className="ta-row ta-n">
                        <input type="checkbox" checked={sel.has(x.id)} onChange={(e) => setNode(x, e.target.checked)} />
                        <span className="nm">{x.name}</span>
                        <span className="c-muted num">{x.host}</span>
                        <span style={{ flex: 1 }} />
                        {other && <span className="ttag" title={tx("При сохранении узел перейдёт на этот шаблон")}>{sel.has(x.id) ? `было: ${other}` : `шаблон «${other}»`}</span>}
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {err && <div className="banner" style={{ margin: "14px 0 0" }}>{err}</div>}
        </div>
        <div className="modal-f">
          <button className="btn ghost" onClick={onClose}>{tx("Отмена")}</button>
          <button className="btn primary" onClick={() => { if (!t.name.trim()) return setErr("введите название"); onSave({ ...t, name: t.name.trim() }, [...sel]); }}>
            Сохранить{sel.size ? ` и применить к ${sel.size}` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface BulkPatch {
  template: string;
  group: string;
  intervalMs: number;
  alerts: "" | "on" | "off";
  enabled: "" | "on" | "off";
  parentId: string;
}

const KEEP = "";
const NO_PARENT = " none";

/** Массовое изменение выбранных целей. */
export function BulkEditModal({ count, targets, groups, templates, onApply, onDelete, onClose }: {
  count: number;
  targets: Target[];
  groups: string[];
  templates: TargetTemplate[];
  onApply: (p: BulkPatch) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [p, setP] = useState<BulkPatch>({ template: KEEP, group: KEEP, intervalMs: 0, alerts: KEEP, enabled: KEEP, parentId: KEEP });
  const changed = p.template || p.group || p.intervalMs || p.alerts || p.enabled || p.parentId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(620px, calc(100vw - 40px))" }}>
        <div className="modal-h"><h2>Изменить выбранные цели: {count}</h2></div>
        <div className="modal-b">
          <div className="c-muted" style={{ fontSize: 12, marginBottom: 12 }}>{tx("Меняются только поля, где выбрано значение. «Не менять» оставляет как есть у каждой цели. История сохраняется.")}</div>
          <div className="form-grid">
            <Field label={tx("Шаблон")} hint={tx("узлы привязываются к шаблону и дальше меняются вместе с ним")}>
              <select className="select" value={p.template} onChange={(e) => setP({ ...p, template: e.target.value })}>
                <option value={KEEP}>{tx("— не менять —")}</option>
                <option value={NO_PARENT}>{tx("Отвязать от шаблона (значения останутся)")}</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label={tx("Группа")}>
              <select className="select" value={p.group} onChange={(e) => setP({ ...p, group: e.target.value })}>
                <option value={KEEP}>{tx("— не менять —")}</option>
                {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
            <Field label={tx("Интервал проверки")} hint={p.template && p.template !== NO_PARENT ? "задано вручную — узлы не будут привязаны к шаблону" : undefined}>
              <select className="select" value={p.intervalMs} onChange={(e) => setP({ ...p, intervalMs: Number(e.target.value) })}>
                <option value={0}>{tx("— не менять —")}</option>
                {INTERVALS.map((v) => <option key={v} value={v}>{fmtInterval(v)}</option>)}
              </select>
            </Field>
            <Field label={tx("Уведомления")} hint={p.template && p.template !== NO_PARENT ? "задано вручную — узлы не будут привязаны к шаблону" : undefined}>
              <select className="select" value={p.alerts} onChange={(e) => setP({ ...p, alerts: e.target.value as BulkPatch["alerts"] })}>
                <option value={KEEP}>{tx("— не менять —")}</option>
                <option value="on">{tx("Включить")}</option>
                <option value="off">{tx("Выключить (режим тишины)")}</option>
              </select>
            </Field>
            <Field label={tx("Мониторинг")}>
              <select className="select" value={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.value as BulkPatch["enabled"] })}>
                <option value={KEEP}>{tx("— не менять —")}</option>
                <option value="on">{tx("Запустить")}</option>
                <option value="off">{tx("Поставить на паузу")}</option>
              </select>
            </Field>
            <Field label={tx("Зависит от узла (родитель)")}>
              <select className="select" value={p.parentId} onChange={(e) => setP({ ...p, parentId: e.target.value })}>
                <option value={KEEP}>{tx("— не менять —")}</option>
                <option value={NO_PARENT}>{tx("Убрать зависимость")}</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.name !== t.host ? ` — ${t.host}` : ""}</option>)}
              </select>
            </Field>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn danger" onClick={onDelete}>Удалить {count}…</button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>{tx("Отмена")}</button>
          <button className="btn primary" disabled={!changed} onClick={() => onApply(p)}>Применить к {count}</button>
        </div>
      </div>
    </div>
  );
}

/** Применяет изменения из массового редактирования к цели. */
export function applyBulk(t: Target, p: BulkPatch, templates: TargetTemplate[]): Target {
  let x = { ...t };
  const tpl = templates.find((z) => z.id === p.template);
  if (tpl) x = applyTemplate(x, tpl);
  if (p.template === NO_PARENT) x.templateId = null;
  if (p.group) x.group = p.group;
  if (p.intervalMs) { x.intervalMs = p.intervalMs; x.templateId = null; }
  if (p.alerts) { x.alertsEnabled = p.alerts === "on"; x.templateId = null; }
  if (p.enabled) x.enabled = p.enabled === "on";
  if (p.parentId === NO_PARENT) x.parentId = null;
  else if (p.parentId && p.parentId !== x.id) x.parentId = p.parentId;
  return x;
}
