import { t as tx } from "../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseList } from "../parse";
import { api } from "../api";
import { fmtInterval } from "../format";
import type { CheckKind, Target, Thresholds } from "../types";
import { DEFAULT_GROUP, DEFAULT_THRESHOLDS, HTTP_THRESHOLDS, defaultTarget } from "../types";
import { Field, NumInput, ThresholdFields, Toggle } from "./ui";
import type { TargetTemplate } from "../types";
import { applyTemplate, templateSummary } from "./Templates";

const KINDS: { k: CheckKind; t: string; d: string }[] = [
  { k: "trace", t: "Трассировка", d: "Все промежуточные узлы до цели" },
  { k: "ping", t: "Ping", d: "Только конечный узел, ICMP" },
  { k: "http", t: "HTTP(S)", d: "Код ответа, время, SSL" },
  { k: "tcp", t: "TCP-порт", d: "Доступность порта" },
  { k: "dns", t: "DNS", d: "DNS-сервер: скорость и ответ" },
];

const KIND_SHORT: Record<CheckKind, string> = { trace: "трасс.", ping: "ping", http: "http", tcp: "tcp", dns: "dns" };

const INTERVALS = [1000, 2500, 5000, 10000, 15000, 30000, 60000, 300000];

interface Props {
  initial: Target | null;
  groups: string[];
  defaultGroup?: string | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}

const NEW_GROUP = "\u0000new";

export function TargetModal({ initial, groups, defaultGroup, onClose, onSaved }: Props) {
  const isNew = !initial?.id;
  const [state, setT] = useState<Target>(() => initial ?? { ...defaultTarget(), group: defaultGroup || groups[0] || "Общее" });
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = state;
  const [newGroup, setNewGroup] = useState(false);
  const baseTh = useRef<Thresholds>({ ...DEFAULT_THRESHOLDS });

  useEffect(() => {
    if (!isNew) return;
    api.settings().then((s) => {
      baseTh.current = { ...s.defaultThresholds };
      setT((x) => x.templateId ? x : ({ ...x, intervalMs: s.defaultIntervalMs, thresholds: x.kind === "http" ? { ...HTTP_THRESHOLDS } : { ...s.defaultThresholds } }));
    });
  }, [isNew]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [templates, setTemplates] = useState<TargetTemplate[]>([]);
  const [unlinkedFrom, setUnlinkedFrom] = useState<string | null>(null);
  const tplTouched = useRef(false);
  const groupTpl = (g: string, list = templates) => list.find((x) => (x.groups ?? []).includes(g));
  useEffect(() => {
    api.settings().then((s) => {
      const list = s.templates ?? [];
      setTemplates(list);
      // Новая цель в группе, закреплённой за шаблоном, сразу получает его.
      if (isNew) setT((x) => { const tp = groupTpl(x.group, list); return tp && !x.templateId ? applyTemplate(x, tp) : x; });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const linked = templates.find((x) => x.id === t.templateId) ?? null;
  const pickTemplate = (tp: TargetTemplate | null) => {
    tplTouched.current = true;
    setUnlinkedFrom(null);
    setT((x) => (tp ? applyTemplate(x, tp) : { ...x, templateId: null }));
  };
  const [allTargets, setAllTargets] = useState<Target[]>([]);
  useEffect(() => { api.listTargets().then(setAllTargets).catch(() => {}); }, []);
  const parentOptions = useMemo(() => {
    const byGroup = new Map<string, Target[]>();
    for (const x of allTargets) {
      if (x.id === t.id && t.id) continue;
      if (!byGroup.has(x.group)) byGroup.set(x.group, []);
      byGroup.get(x.group)!.push(x);
    }
    return [...byGroup.entries()];
  }, [allTargets, t.id]);
  const [expectedText, setExpectedText] = useState(() => (initial?.dns?.expected ?? []).join(", "));

  const [existing, setExisting] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (bulk) api.listTargets().then((l) => setExisting(new Set(l.filter((x) => x.kind === t.kind).map((x) => x.host.toLowerCase()))));
  }, [bulk, t.kind]);
  const parsed = useMemo(() => {
    if (!bulk) return [];
    const seen = new Set<string>();
    return parseList(bulkText, t.kind, t.port).map((p) => {
      const key = `${p.host.toLowerCase()}:${p.port ?? ""}`;
      if (!p.error && seen.has(key)) return { ...p, error: "повтор в списке" };
      seen.add(key);
      return p;
    });
  }, [bulk, bulkText, t.kind, t.port]);
  const validCount = parsed.filter((p) => !p.error && !existing.has(p.host.toLowerCase())).length;

  const groupOptions = useMemo(() => {
    const list = [DEFAULT_GROUP, ...groups.filter((g) => g !== DEFAULT_GROUP)];
    if (t.group && !list.includes(t.group) && !newGroup) list.push(t.group);
    return list;
  }, [groups, t.group, newGroup]);

  const set = <K extends keyof Target>(k: K, v: Target[K]) => setT((x) => ({ ...x, [k]: v }));
  /** Поля, которые задаёт шаблон: ручное изменение отвязывает цель от шаблона. */
  const setTpl = <K extends "intervalMs" | "timeoutMs" | "thresholds" | "alertsEnabled">(k: K, v: Target[K]) => {
    if (linked) setUnlinkedFrom(linked.name);
    setT((x) => ({ ...x, [k]: v, templateId: null }));
  };
  const setGroup = (g: string) => {
    setT((x) => {
      const tp = groupTpl(g);
      if (isNew && !tplTouched.current && tp) return { ...applyTemplate(x, tp), group: g };
      return { ...x, group: g };
    });
  };
  const setKind = (k: CheckKind) =>
    setT((x) => x.templateId ? { ...x, kind: k, port: k === "tcp" ? x.port ?? 443 : x.port } : ({
      ...x,
      kind: k,
      intervalMs: k === "http" || k === "dns" ? Math.max(x.intervalMs, 30000) : k === "tcp" ? Math.max(x.intervalMs, 5000) : x.intervalMs >= 30000 ? 2500 : x.intervalMs,
      thresholds:
        k === "http" && x.thresholds.warnMs < 300
          ? { ...x.thresholds, warnMs: HTTP_THRESHOLDS.warnMs, badMs: HTTP_THRESHOLDS.badMs, critMs: HTTP_THRESHOLDS.critMs }
          : k !== "http" && x.thresholds.warnMs >= 300
            ? { ...x.thresholds, warnMs: baseTh.current.warnMs, badMs: baseTh.current.badMs, critMs: baseTh.current.critMs }
            : x.thresholds,
      port: k === "tcp" ? x.port ?? 443 : x.port,
    }));

  const save = async () => {
    const t = {
      ...state,
      group: state.group.trim() || DEFAULT_GROUP,
      dns: { ...state.dns, expected: expectedText.split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean) },
    };
    setErr(null);
    setBusy(true);
    try {
      if (bulk) {
        const ok = parsed.filter((p) => !p.error && !existing.has(p.host.toLowerCase()));
        if (!ok.length) throw parsed.length ? "нет новых корректных адресов для добавления" : "введите хотя бы один адрес";
        const list: Target[] = ok.map((p) => ({ ...t, id: "", host: p.host, name: p.name, port: t.kind === "tcp" ? p.port : t.port }));
        const n = await api.saveTargets(list);
        const skipped = parsed.length - n;
        onSaved(`Добавлено целей: ${n}${skipped ? ` (пропущено: ${skipped})` : ""}`);
      } else {
        await api.saveTarget(t);
        onSaved(isNew ? `Цель «${t.name || t.host}» добавлена` : "Изменения сохранены");
      }
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const placeholder = t.kind === "http" ? "https://app.example.com/health" : t.kind === "dns" ? "10.0.0.53 — адрес DNS-сервера, или имя example.com" : "server.example.com или 10.0.0.1";
  const dnsIsServer = /^[\d.]+$|:/.test(t.host.trim());

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-h">
          <h2>{isNew ? "Новая цель мониторинга" : `Настройки: ${initial?.name}`}</h2>
          <div style={{ flex: 1 }} />
          {isNew && (
            <div className="chips">
              <button className={!bulk ? "on" : ""} onClick={() => setBulk(false)}>{tx("Одна")}</button>
              <button className={bulk ? "on" : ""} onClick={() => setBulk(true)}>{tx("Списком")}</button>
            </div>
          )}
        </div>
        <div className="modal-b">
          <div className="kind-pick">
            {KINDS.map((k) => (
              <button key={k.k} className={t.kind === k.k ? "on" : ""} onClick={() => setKind(k.k)}>
                <b>{k.t}</b>
                <small>{k.d}</small>
              </button>
            ))}
          </div>
          {templates.length > 0 && (
            <div className="tpl-pick">
              <span className="c-muted" style={{ fontSize: 12 }}>{tx("Шаблон:")}</span>
              <div className="chips" style={{ flexWrap: "wrap", height: "auto" }}>
                <button className={!t.templateId ? "on" : ""} title={tx("Свои настройки, без привязки")} onClick={() => pickTemplate(null)}>{tx("Без шаблона")}</button>
                {templates.map((tp) => (
                  <button key={tp.id} className={t.templateId === tp.id ? "on" : ""} title={templateSummary(tp)} onClick={() => pickTemplate(tp)}>{tp.name}</button>
                ))}
              </div>
            </div>
          )}
          {linked && (
            <div className="tpl-link">
              <span>{tx("Интервал, таймаут, пороги и уведомления берутся из шаблона")} <b className="c-ok">«{linked.name}»</b> {tx("и меняются вместе с ним. Изменить их здесь — значит отвязать цель от шаблона.")}</span>
            </div>
          )}
          {!linked && unlinkedFrom && (
            <div className="tpl-link">
              <span className="c-warn">Значения изменены вручную — цель отвязана от шаблона «{unlinkedFrom}».</span>
              <button className="btn ghost sm" onClick={() => { const tp = templates.find((x) => x.name === unlinkedFrom); if (tp) pickTemplate(tp); }}>{tx("Вернуть шаблон")}</button>
            </div>
          )}
          <div className="sep" />
          <div className="form-grid">
            {bulk ? (
              <Field full label={tx("Адреса — по одному в строке")} hint={<>{tx("Подходит любой формат:")} <code>{tx("10.0.0.1 Название")}</code>, <code>{tx("Название, host.example.com")}</code>{tx(", просто")} <code>host.example.com</code>. Адрес находится автоматически, остальное — название.{t.kind === "tcp" && <> {tx("Порт:")} <code>db.example.local:5432</code> {tx("или поле «Порт» ниже.")}</>} Строки с # игнорируются.</>}>
                <textarea className="textarea" rows={8} value={bulkText} onChange={(e) => setBulkText(e.target.value)} placeholder={"192.0.2.10 Шлюз площадки\n10.0.0.1 RTR-01\nСервер приложений, 10.0.1.10\napp.example.com"} autoFocus />
                {parsed.length > 0 && (
                  <div className="bulk-preview">
                    <div className="bulk-head">{tx("Распознано:")} <b className="c-ok">{validCount}</b> из {parsed.length}</div>
                    <table className="grid">
                      <tbody>
                        {parsed.map((p, i) => {
                          const dup = !p.error && existing.has(p.host.toLowerCase());
                          return (
                            <tr key={i} style={{ cursor: "default" }}>
                              <td className="num" style={{ width: "40%" }}>{p.host || <span className="c-dim">—</span>}{p.port && t.kind === "tcp" ? <span className="c-muted">:{p.port}</span> : null}</td>
                              <td>{p.name || <span className="c-dim">{tx("без названия")}</span>}</td>
                              <td className="r">{p.error ? <span className="c-down">{p.error}</span> : dup ? <span className="c-warn">{tx("уже есть")}</span> : <span className="c-ok">✓</span>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Field>
            ) : (
              <>
                <Field label={t.kind === "http" ? "URL" : "Адрес (хост или IP)"}>
                  <input className="input" value={t.host} onChange={(e) => set("host", e.target.value)} placeholder={placeholder} autoFocus />
                </Field>
                <Field label={tx("Название")}>
                  <input className="input" value={t.name} onChange={(e) => set("name", e.target.value)} placeholder={tx("Например: CRM")} />
                </Field>
              </>
            )}
            <Field label={tx("Группа")}>
              {newGroup ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <input className="input" autoFocus value={t.group} placeholder={tx("Название новой группы")} onChange={(e) => set("group", e.target.value)} />
                  <button className="btn" title={tx("Выбрать из существующих")} onClick={() => { setNewGroup(false); set("group", groupOptions.includes(t.group) ? t.group : groupOptions[0]); }}>✕</button>
                </div>
              ) : (
                <select
                  className="select"
                  value={t.group}
                  onChange={(e) => {
                    if (e.target.value === NEW_GROUP) { setNewGroup(true); set("group", ""); } else setGroup(e.target.value);
                  }}
                >
                  {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
                  <option value={NEW_GROUP}>{tx("＋ Новая группа…")}</option>
                </select>
              )}
            </Field>
            <Field label={tx("Интервал проверки")}>
              <select className="select" value={t.intervalMs} onChange={(e) => setTpl("intervalMs", Number(e.target.value))}>
                {[...new Set([...INTERVALS, t.intervalMs])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{fmtInterval(v)}</option>)}
              </select>
            </Field>
            {t.kind === "tcp" && (
              <Field label={tx("Порт")}>
                <NumInput value={t.port ?? 0} min={1} max={65535} onChange={(v) => set("port", v || null)} />
              </Field>
            )}
            <Field label={tx("Таймаут, мс")}>
              <NumInput value={t.timeoutMs} min={200} max={60000} step={100} onChange={(v) => setTpl("timeoutMs", v)} />
            </Field>
            {(t.kind === "trace" || t.kind === "ping") && (
              <Field label={tx("Размер пакета, байт")}>
                <NumInput value={t.packetSize} min={0} max={1472} onChange={(v) => set("packetSize", v)} />
              </Field>
            )}
            {t.kind === "trace" && (
              <Field label={tx("Максимум хопов")}>
                <NumInput value={t.maxHops} min={1} max={64} onChange={(v) => set("maxHops", v)} />
              </Field>
            )}
          </div>

          {t.kind === "dns" && (
            <>
              <div className="sep" />
              <div className="form-grid">
                <Field label={tx("Какое имя запрашивать")} hint={dnsIsServer || bulk ? "адрес цели — IP DNS-сервера: спрашиваем у него это имя напрямую" : "адрес цели — имя: резолвится системным DNS, это поле не используется"}>
                  <input className="input" value={t.dns.query} onChange={(e) => set("dns", { ...t.dns, query: e.target.value })} placeholder="example.com" disabled={!dnsIsServer && !bulk} />
                </Field>
                <Field label={tx("Ожидаемые IP в ответе")} hint={tx("через запятую; если ответ другой — ошибка (защита от подмены). Пусто — любой ответ")}>
                  <input className="input" value={expectedText} onChange={(e) => setExpectedText(e.target.value)} placeholder="192.0.2.10, 192.0.2.11" />
                </Field>
              </div>
            </>
          )}

          {t.kind === "http" && (
            <>
              <div className="sep" />
              <div className="form-grid three">
                <Field label={tx("Метод")}>
                  <select className="select" value={t.http.method} onChange={(e) => set("http", { ...t.http, method: e.target.value })}>
                    {["GET", "HEAD", "POST", "OPTIONS"].map((m) => <option key={m}>{m}</option>)}
                  </select>
                </Field>
                <Field label={tx("Ожидаемые коды")} hint={tx("через запятую; пусто = любой 2xx/3xx")}>
                  <input className="input" value={t.http.expectedStatus.join(", ")} onChange={(e) => set("http", { ...t.http, expectedStatus: e.target.value.split(/[,\s]+/).map(Number).filter((n) => n >= 100 && n < 600) })} placeholder="200, 204" />
                </Field>
                <Field label={tx("Ключевое слово в ответе")} hint={tx("необязательно")}>
                  <input className="input" value={t.http.keyword} onChange={(e) => set("http", { ...t.http, keyword: e.target.value })} placeholder='"status":"ok"' />
                </Field>
              </div>
              <div style={{ display: "flex", gap: 24, marginTop: 12 }}>
                <Toggle checked={t.http.verifyTls} onChange={(v) => set("http", { ...t.http, verifyTls: v })} label={tx("Проверять SSL-сертификат")} />
                <Toggle checked={t.http.followRedirects} onChange={(v) => set("http", { ...t.http, followRedirects: v })} label={tx("Следовать редиректам")} />
              </div>
            </>
          )}

          <div className="sep" />
          <div className="form-grid">
            <Field label={tx("Зависит от узла (родитель)")} hint={tx("если родитель недоступен, эта цель помечается «из-за родителя» и не шлёт уведомлений")}>
              <select className="select" value={t.parentId ?? ""} onChange={(e) => set("parentId", e.target.value || null)}>
                <option value="">{tx("— не зависит —")}</option>
                {parentOptions.map(([g, list]) => (
                  <optgroup key={g} label={g}>
                    {list.map((x) => <option key={x.id} value={x.id}>{x.name}{x.name !== x.host ? ` — ${x.host}` : ""} ({KIND_SHORT[x.kind]})</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
          </div>

          <div className="sep" />
          <div className="section-title" style={{ marginBottom: 10 }}>{tx("Пороги (цвет статуса и оповещения)")}</div>
          <ThresholdFields value={t.thresholds} onChange={(v) => setTpl("thresholds", v)} latency={t.kind !== "http"} voip={t.kind === "trace" || t.kind === "ping"} />
          <div style={{ display: "flex", gap: 24, marginTop: 14 }}>
            <Toggle checked={t.alertsEnabled} onChange={(v) => setTpl("alertsEnabled", v)} label={tx("Уведомления")} />
            {!t.alertsEnabled && <span className="c-muted" style={{ fontSize: 12, alignSelf: "center" }}>{tx("режим тишины: события пишутся в журнал, но без оповещений")}</span>}
            <Toggle checked={t.enabled} onChange={(v) => set("enabled", v)} label={tx("Мониторинг включён")} />
          </div>
          {!bulk && (
            <>
              <div className="sep" />
              <Field full label={tx("Заметки")}>
                <textarea className="textarea" rows={2} style={{ fontFamily: "var(--sans)" }} value={t.notes} onChange={(e) => set("notes", e.target.value)} placeholder={tx("Кто отвечает, контакты провайдера…")} />
              </Field>
            </>
          )}
          {err && <div className="banner" style={{ margin: "14px 0 0" }}>{err}</div>}
        </div>
        <div className="modal-f">
          <button className="btn ghost" onClick={onClose}>{tx("Отмена")}</button>
          <button className="btn primary" onClick={save} disabled={busy || (bulk && validCount === 0)}>{bulk ? `Добавить ${validCount || ""}`.trim() : isNew ? "Добавить" : "Сохранить"}</button>
        </div>
      </div>
    </div>
  );
}
