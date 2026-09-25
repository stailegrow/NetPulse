import { useEffect, useState } from "react";
import { api, isTauri } from "../api";
import type { DuplicatePair, EngineInfo, Settings, Target, TargetTemplate, UpdateInfo } from "../types";
import { defaultTemplates } from "../types";
import { TemplateEditor, templateSummary } from "../components/Templates";
import { DEFAULT_THRESHOLDS } from "../types";
import { fmtInterval, plural } from "../format";
import { Field, NumInput, ThresholdFields, Toggle } from "../components/ui";
import { beep } from "../sound";
import { ask } from "../components/Dialogs";
import { setLang, t } from "../i18n";

type TabKey = "general" | "alerts" | "templates" | "data" | "updates" | "about";
const TABS: { k: TabKey; l: string }[] = [
  { k: "general", l: "Общие" },
  { k: "alerts", l: "Уведомления" },
  { k: "templates", l: "Шаблоны" },
  { k: "data", l: "Данные" },
  { k: "updates", l: "Обновления" },
  { k: "about", l: "О программе" },
];

export function SettingsPage({ toast, onImported }: { toast: (m: string, k?: string) => void; onImported: () => void }) {
  const [tab, setTab] = useState<TabKey>(() => {
    try { return (localStorage.getItem("np.settingsTab") as TabKey) || "general"; } catch { return "general"; }
  });
  const setTabPersist = (t: TabKey) => { setTab(t); try { localStorage.setItem("np.settingsTab", t); } catch { /* */ } };
  const [log, setLog] = useState<string | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [orig, setOrig] = useState<string>("");
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [withSettings, setWithSettings] = useState(true);
  const [hist, setHist] = useState<{ samples: number; rollups: number; events: number; dbBytes: number } | null>(null);
  const [histEvents, setHistEvents] = useState(true);
  const [clearing, setClearing] = useState(false);
  const loadHist = () => api.historyStats().then(setHist).catch(() => {});
  const [tplEdit, setTplEdit] = useState<{ tpl: TargetTemplate; index: number } | null>(null);
  const [tTargets, setTTargets] = useState<Target[]>([]);
  const [tGroups, setTGroups] = useState<string[]>([]);
  const loadTplData = () => {
    api.listTargets().then(setTTargets).catch(() => {});
    api.listGroups().then(setTGroups).catch(() => {});
  };
  useEffect(loadTplData, []);
  const usage = (id: string) => tTargets.filter((x) => x.templateId === id);
  // Шаблоны сохраняются сразу, не трогая другие несохранённые правки на странице.
  const saveTemplates = async (list: TargetTemplate[]) => {
    try {
      const base = JSON.parse(orig) as Settings;
      await api.saveSettings({ ...base, templates: list });
      setOrig(JSON.stringify({ ...base, templates: list }));
      setS((cur) => (cur ? { ...cur, templates: list } : cur));
      loadTplData();
      return true;
    } catch (e) {
      toast(String(e), "error");
      return false;
    }
  };
  const [dups, setDups] = useState<DuplicatePair[] | null>(null);
  const [dupSel, setDupSel] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);
  const [updSource, setUpdSource] = useState<string | null>(null);
  const [projectPage, setProjectPage] = useState<string | null>(null);
  useEffect(() => {
    api.updateSource().then(setUpdSource).catch(() => {});
    api.projectPage().then(setProjectPage).catch(() => {});
  }, []);
  const [upd, setUpd] = useState<{ state: "idle" | "checking" | "none" | "available" | "installing" | "error"; info?: UpdateInfo; error?: string }>({ state: "idle" });

  const findDups = async () => {
    const d = await api.findDuplicates();
    setDups(d);
    setDupSel(new Set(d.map((x) => x.pingId)));
  };
  const mergeDups = async () => {
    const pairs = (dups ?? []).filter((d) => dupSel.has(d.pingId));
    if (!pairs.length) return;
    if (!(await ask({ title: `Объединить ${plural(pairs.length, "пару", "пары", "пар")}?`, message: "Останутся цели-трассировки. Ping-цели будут удалены, их минутная история (аптайм, отчёты) и события перейдут в трассировку. Подробные данные ping за последние 3 суток не переносятся.", confirm: "Объединить" }))) return;
    setMerging(true);
    try {
      const n = await api.mergeDuplicates(pairs);
      toast(`Объединено пар: ${n}`, "ok");
      onImported();
      await findDups();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setMerging(false);
    }
  };
  const checkUpd = async () => {
    if (dirty) { await api.saveSettings(s!); setOrig(JSON.stringify(s)); }
    setUpd({ state: "checking" });
    try {
      const info = await api.checkUpdate();
      setUpd(info ? { state: "available", info } : { state: "none" });
    } catch (e) {
      setUpd({ state: "error", error: String(e) });
    }
  };
  const installUpd = async () => {
    setUpd((u) => ({ ...u, state: "installing" }));
    try {
      await api.installUpdate();
    } catch (e) {
      setUpd({ state: "error", error: String(e) });
    }
  };

  useEffect(() => {
    api.settings().then((x) => { setS(x); setOrig(JSON.stringify(x)); });
    api.engineInfo().then(setInfo);
    loadHist();
  }, []);

  if (!s) return null;
  const dirty = JSON.stringify(s) !== orig;
  const ch = s.channels;
  const setCh = (patch: Partial<Settings["channels"]>) => setS({ ...s, channels: { ...ch, ...patch } });
  const rules = s.alertRules;
  const setRules = (patch: Partial<Settings["alertRules"]>) => setS({ ...s, alertRules: { ...rules, ...patch } });

  const save = async () => {
    try {
      await api.saveSettings(s);
      setOrig(JSON.stringify(s));
      // Язык применяем сразу, не дожидаясь перезапуска.
      setLang(s.language);
      onImported();
      toast(t("Настройки сохранены"), "ok");
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const test = async (channel: string) => {
    if (dirty) await api.saveSettings(s).then(() => setOrig(JSON.stringify(s)));
    setTesting(channel);
    try {
      if (channel === "system") await api.testSystemNotification();
      else if (channel === "sound") beep("critical");
      else await api.testChannel(channel);
      if (channel !== "sound") toast("Тестовое сообщение отправлено", "ok");
    } catch (e) {
      toast(`Ошибка: ${e}`, "error");
    } finally {
      setTesting(null);
    }
  };

  const TestBtn = ({ c }: { c: string }) => (
    <button className="btn sm" disabled={testing === c} onClick={() => test(c)}>{testing === c ? "Отправка…" : "Тест"}</button>
  );

  return (
    <div className="settings">      <div className="settings-tabs">
        {TABS.map((x) => (
          <button key={x.k} className={tab === x.k ? "on" : ""} onClick={() => setTabPersist(x.k)}>{t(x.l)}</button>
        ))}
      </div>

      {tab === "general" && (
        <>

      <div className="card">
        <h3>{t("Общие")}</h3>
        <div className="form-grid three" style={{ marginTop: 12 }}>
          <Field label={t("Язык интерфейса")} hint={t("выводы анализатора и журнал событий пока только на русском")}>
            <select className="select" value={s.language} onChange={(e) => setS({ ...s, language: e.target.value as Settings["language"] })}>
              <option value="ru">{t("Русский")}</option>
              <option value="en">English</option>
            </select>
          </Field>
          <Field label={t("Интервал для новых целей")}>
            <select className="select" value={s.defaultIntervalMs} onChange={(e) => setS({ ...s, defaultIntervalMs: Number(e.target.value) })}>
              {[1000, 2500, 5000, 10000, 30000, 60000].map((v) => <option key={v} value={v}>{fmtInterval(v)}</option>)}
            </select>
          </Field>
        </div>
        <div className="sep" />
        <div className="sep" />
        <div className="section-title">
          Пороги по умолчанию для новых целей
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => setS({ ...s, defaultThresholds: { ...DEFAULT_THRESHOLDS } })} title={t("10 / 30 / 50 мс, потери 5 / 10 %")}>{t("Рекомендуемые")}</button>
          <button
            className="btn sm"
            title={t("Записать эти пороги во все цели (кроме HTTP) — история сохраняется")}
            onClick={async () => {
              if (!(await ask({ title: "Применить пороги ко всем целям?", message: "Пороги задержки и потерь будут записаны во все цели, кроме HTTP(S). История сохранится.", confirm: "Применить" }))) return;
              try {
                const list = (await api.listTargets()).filter((t) => t.kind !== "http");
                for (const t of list) await api.saveTarget({ ...t, thresholds: { ...s.defaultThresholds } });
                toast(`Пороги применены к целям: ${list.length}`, "ok");
                onImported();
              } catch (e) { toast(String(e), "error"); }
            }}
          >{t("Применить ко всем целям")}</button>
        </div>
        <ThresholdFields value={s.defaultThresholds} onChange={(v) => setS({ ...s, defaultThresholds: v })} />
        <div className="sep" />
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
          <Toggle checked={s.minimizeToTray} onChange={(v) => setS({ ...s, minimizeToTray: v })} label={t("При закрытии окна продолжать работу в трее / меню-баре")} />
          <Toggle checked={s.launchAtLogin} onChange={(v) => setS({ ...s, launchAtLogin: v })} label={t("Запускать при входе в систему")} />
        </div>
      </div>

        </>
      )}

      {tab === "alerts" && (
        <>

      <div className="card">
        <h3>{t("Оповещения — когда срабатывать")}</h3>
        <div className="desc">{t("Пороги задержки и потерь задаются в настройках каждой цели. Здесь — общие правила.")}</div>
        <div className="form-grid">
          <Field label={t("«Недоступен» после N потерь подряд")} hint={`при интервале 2.5 с это ≈ ${fmtInterval(rules.downAfterSamples * 2500)}`}>
            <NumInput value={rules.downAfterSamples} min={1} max={100} onChange={(v) => setRules({ downAfterSamples: v })} />
          </Field>
          <Field label={t("Окно оценки потерь и задержки, проверок")} hint={t("среднее по последним N проверкам")}>
            <NumInput value={rules.windowSamples} min={2} max={1000} onChange={(v) => setRules({ windowSamples: v })} />
          </Field>
          <Field label={t("Предупреждать об истечении SSL за, дней")} hint={t("0 — не проверять")}>
            <NumInput value={rules.certDays} min={0} max={365} onChange={(v) => setRules({ certDays: v })} />
          </Field>
          <Field label={t("Повторять напоминание каждые, мин")} hint={t("0 — только одно уведомление на проблему")}>
            <NumInput value={rules.repeatMinutes} min={0} max={1440} onChange={(v) => setRules({ repeatMinutes: v })} />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
          <Toggle checked={rules.lossEnabled} onChange={(v) => setRules({ lossEnabled: v })} label={t("Потери выше «красного» порога")} />
          <Toggle checked={rules.latencyEnabled} onChange={(v) => setRules({ latencyEnabled: v })} label={t("Задержка выше «красного» порога")} />
          <Toggle checked={rules.routeChangeEnabled} onChange={(v) => setRules({ routeChangeEnabled: v })} label={t("Смена маршрута (Telegram / почта / вебхук)")} />
          <Toggle checked={rules.notifyRecovery} onChange={(v) => setRules({ notifyRecovery: v })} label={t("Сообщать о восстановлении")} />
        </div>
      </div>


      <div className="card">
        <h3>{t("Уведомления на этом компьютере")}</h3>
        <div style={{ display: "flex", gap: 28, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}><Toggle checked={ch.system} onChange={(v) => setCh({ system: v })} label={isTauriLabel()} /><TestBtn c="system" /></span>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}><Toggle checked={ch.sound} onChange={(v) => setCh({ sound: v })} label={t("Звуковой сигнал")} /><TestBtn c="sound" /></span>
        </div>
      </div>


      <div className="card">
        <h3><Toggle checked={ch.telegram.enabled} onChange={(v) => setCh({ telegram: { ...ch.telegram, enabled: v } })} /> Telegram <span style={{ flex: 1 }} /><TestBtn c="telegram" /></h3>
        <div className="desc">{t("Создайте бота через @BotFather и получите токен. Добавьте бота в чат/группу IT и узнайте chat_id (например, через @userinfobot или getUpdates).")}</div>
        <div className="form-grid">
          <Field label={t("Токен бота")}><input className="input num" type="password" value={ch.telegram.botToken} onChange={(e) => setCh({ telegram: { ...ch.telegram, botToken: e.target.value.trim() } })} placeholder="123456:ABC-DEF…" /></Field>
          <Field label="Chat ID"><input className="input num" value={ch.telegram.chatId} onChange={(e) => setCh({ telegram: { ...ch.telegram, chatId: e.target.value.trim() } })} placeholder="-1001234567890" /></Field>
        </div>
      </div>


      <div className="card">
        <h3><Toggle checked={ch.webhook.enabled} onChange={(v) => setCh({ webhook: { ...ch.webhook, enabled: v } })} /> {t("Вебхук (Slack, Discord, Mattermost, свой сервис)")} <span style={{ flex: 1 }} /><TestBtn c="webhook" /></h3>
        <div className="form-grid" style={{ gridTemplateColumns: "3fr 1fr", marginTop: 12 }}>
          <Field label="URL"><input className="input num" value={ch.webhook.url} onChange={(e) => setCh({ webhook: { ...ch.webhook, url: e.target.value.trim() } })} placeholder="https://hooks.slack.com/services/…" /></Field>
          <Field label={t("Формат")}>
            <select className="select" value={ch.webhook.format} onChange={(e) => setCh({ webhook: { ...ch.webhook, format: e.target.value as "slack" } })}>
              <option value="slack">Slack / Mattermost</option>
              <option value="discord">Discord</option>
              <option value="generic">JSON</option>
            </select>
          </Field>
        </div>
      </div>


      <div className="card">
        <h3><Toggle checked={ch.email.enabled} onChange={(v) => setCh({ email: { ...ch.email, enabled: v } })} /> {t("Электронная почта (SMTP)")} <span style={{ flex: 1 }} /><TestBtn c="email" /></h3>
        <div className="form-grid three" style={{ marginTop: 12 }}>
          <Field label={t("SMTP-сервер")}><input className="input" value={ch.email.host} onChange={(e) => setCh({ email: { ...ch.email, host: e.target.value.trim() } })} placeholder="smtp.example.com" /></Field>
          <Field label={t("Порт")}><NumInput value={ch.email.port} onChange={(v) => setCh({ email: { ...ch.email, port: v } })} /></Field>
          <Field label={t("Шифрование")}>
            <select className="select" value={ch.email.security} onChange={(e) => setCh({ email: { ...ch.email, security: e.target.value as "tls" } })}>
              <option value="starttls">STARTTLS (587)</option>
              <option value="tls">SSL/TLS (465)</option>
              <option value="none">{t("Без шифрования")}</option>
            </select>
          </Field>
          <Field label={t("Логин")}><input className="input" value={ch.email.username} onChange={(e) => setCh({ email: { ...ch.email, username: e.target.value } })} /></Field>
          <Field label={t("Пароль")}><input className="input" type="password" value={ch.email.password} onChange={(e) => setCh({ email: { ...ch.email, password: e.target.value } })} /></Field>
          <Field label={t("От кого")}><input className="input" value={ch.email.from} onChange={(e) => setCh({ email: { ...ch.email, from: e.target.value } })} placeholder="netpulse@example.com" /></Field>
          <Field full label={t("Кому (через запятую)")}><input className="input" value={ch.email.to} onChange={(e) => setCh({ email: { ...ch.email, to: e.target.value } })} placeholder="noc@example.com, ops@example.com" /></Field>
        </div>
      </div>

        </>
      )}

      {tab === "templates" && (
        <>

      <div className="card">
        <h3>{t("Шаблоны целей")}</h3>
        <div className="desc">{t("Шаблон — общий набор настроек: интервал, таймаут, пороги (включая jitter и MOS) и уведомления. Привяжите к нему узлы или целые группы в окне «Изменить» — и все они будут меняться вместе с шаблоном. Узел можно привязать и в его настройках, и массово: галочки в «Все цели» → «Изменить выбранные».")}</div>
        {(s.templates ?? []).map((tpl, i) => {
          const used = usage(tpl.id);
          const names = used.slice(0, 12).map((x) => x.name).join("\n") + (used.length > 12 ? `\n… и ещё ${used.length - 12}` : "");
          return (
            <div className="tpl-row" key={tpl.id}>
              <span className="nm">{tpl.name}</span>
              <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <span className="c-muted num" style={{ fontSize: 12 }}>{templateSummary(tpl)}</span>
                <span className={"use " + (used.length || tpl.groups?.length ? "c-ok" : "c-dim")} title={names || undefined}>
                  {used.length ? `целей: ${used.length}` : "не привязан ни к одной цели"}
                  {tpl.groups?.length ? <span className="c-muted"> · группы: {tpl.groups.join(", ")}</span> : null}
                </span>
              </div>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => setTplEdit({ tpl, index: i })}>{t("Изменить")}</button>
              <button className="btn ghost sm" onClick={() => saveTemplates([...s.templates, { ...tpl, id: `t${Date.now()}`, name: `${tpl.name} (копия)`, groups: [] }])}>{t("Копия")}</button>
              <button className="btn ghost sm" onClick={async () => { if (await ask({ title: `Удалить шаблон «${tpl.name}»?`, message: used.length ? `${plural(used.length, "цель отвяжется", "цели отвяжутся", "целей отвяжутся")} от шаблона. Их текущие интервал, пороги и уведомления останутся.` : "Шаблон ни к чему не привязан.", confirm: "Удалить", danger: true })) saveTemplates(s.templates.filter((_, j) => j !== i)); }}>{t("Удалить")}</button>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <button className="btn" onClick={() => setTplEdit({ tpl: { id: `t${Date.now()}`, name: "", intervalMs: s.defaultIntervalMs, timeoutMs: 3000, thresholds: { ...s.defaultThresholds }, alertsEnabled: true, groups: [] }, index: -1 })}>{t("+ Новый шаблон")}</button>
          <button className="btn ghost" onClick={async () => { if (await ask({ title: "Вернуть стандартные шаблоны?", message: "Ваши шаблоны будут заменены набором: L2-линк, Интернет-канал, Телефония, Сайт, DNS-сервер. Узлы отвяжутся от шаблонов, их текущие настройки останутся.", confirm: "Вернуть" })) saveTemplates(defaultTemplates()); }}>{t("Вернуть стандартные")}</button>
        </div>
      </div>

      {tplEdit && (
        <TemplateEditor
          initial={tplEdit.tpl}
          targets={tTargets}
          groups={tGroups}
          templates={s.templates ?? []}
          onClose={() => setTplEdit(null)}
          onSave={async (t, ids) => {
            // Группа закрепляется только за одним шаблоном.
            const list = (s.templates ?? []).map((x) => ({ ...x, groups: (x.groups ?? []).filter((g) => !t.groups.includes(g)) }));
            if (tplEdit.index >= 0) list[tplEdit.index] = t; else list.push(t);
            if (!(await saveTemplates(list))) return;
            try {
              await api.setTemplateTargets(t.id, ids);
              loadTplData();
              toast(`Шаблон «${t.name}» сохранён${ids.length ? ` · привязано целей: ${ids.length}` : ""}`, "ok");
              setTplEdit(null);
              onImported();
            } catch (e) {
              toast(String(e), "error");
            }
          }}
        />
      )}
        </>
      )}

      {tab === "data" && (
        <>

      <div className="card">
        <h3>{t("Хранение данных")}</h3>
        <div className="form-grid three" style={{ marginTop: 12 }}>
          <Field label={t("Хранить подробные данные, часов")} hint={t("каждая проверка и все хопы")}>
            <NumInput value={s.retentionRawHours} min={1} max={24 * 90} onChange={(v) => setS({ ...s, retentionRawHours: v })} />
          </Field>
          <Field label={t("Хранить агрегаты, дней")} hint={t("минутная статистика для отчётов")}>
            <NumInput value={s.retentionRollupDays} min={1} max={3650} onChange={(v) => setS({ ...s, retentionRollupDays: v })} />
          </Field>
        </div>
        <div className="sep" />
        <div className="section-title">{t("История измерений")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span className="c-muted" style={{ fontSize: 12.5 }}>
            {hist
              ? <>{t("Измерений:")} <b className="num c-muted">{hist.samples.toLocaleString("ru-RU")}</b> {t("· агрегатов:")} <b className="num c-muted">{hist.rollups.toLocaleString("ru-RU")}</b> {t("· событий:")} <b className="num c-muted">{hist.events.toLocaleString("ru-RU")}</b> {t("· размер базы:")} <b className="num c-muted">{(hist.dbBytes / 1048576).toFixed(1)} МБ</b></>
              : "…"}
          </span>
          <span style={{ flex: 1 }} />
          <Toggle checked={histEvents} onChange={setHistEvents} label={t("вместе с журналом событий")} />
          <button
            className="btn danger"
            disabled={clearing}
            onClick={async () => {
              const ok = await ask({
                title: "Очистить всю историю?",
                message: <>Будут удалены все измерения и графики{histEvents ? " и журнал событий" : ""} по всем целям. Цели, группы и настройки останутся, мониторинг продолжится. Отменить нельзя.</>,
                confirm: "Очистить",
                danger: true,
              });
              if (!ok) return;
              setClearing(true);
              try {
                await api.clearHistory(histEvents);
                toast("История очищена", "ok");
                loadHist();
              } catch (e) {
                toast(String(e), "error");
              } finally {
                setClearing(false);
              }
            }}
          >
            {clearing ? "Очистка…" : "Очистить историю…"}
          </button>
        </div>
      </div>


      <div className="card">
        <h3>{t("Дубли: ping + трассировка")}</h3>
        <div className="desc">{t("Трассировка уже измеряет задержку и потери до конечного узла, поэтому отдельная ping-цель на тот же адрес не нужна. Объединение оставит трассировку и перенесёт в неё историю ping.")}</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn" onClick={findDups}>{t("Найти дубли")}</button>
          {dups && !dups.length && <span className="c-ok">{t("Дублей нет")}</span>}
          {dups && dups.length > 0 && (
            <>
              <span className="c-muted">Найдено пар: {dups.length}, выбрано: {dupSel.size}</span>
              <span style={{ flex: 1 }} />
              <button className="btn primary" onClick={mergeDups} disabled={merging || !dupSel.size}>{merging ? "Объединяю…" : `Объединить выбранные (${dupSel.size})`}</button>
            </>
          )}
        </div>
        {dups && dups.length > 0 && (
          <div className="table-wrap" style={{ padding: 0, marginTop: 10, maxHeight: 320, overflow: "auto" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 30 }}><input type="checkbox" checked={dupSel.size === dups.length} onChange={(e) => setDupSel(e.target.checked ? new Set(dups.map((d) => d.pingId)) : new Set())} /></th>
                  <th>{t("Адрес")}</th><th>{t("Ping (будет удалена)")}</th><th>{t("Трассировка (останется)")}</th><th>{t("Группа")}</th>
                </tr>
              </thead>
              <tbody>
                {dups.map((d) => (
                  <tr key={d.pingId} onClick={() => setDupSel((cur) => { const n = new Set(cur); if (n.has(d.pingId)) n.delete(d.pingId); else n.add(d.pingId); return n; })}>
                    <td><input type="checkbox" readOnly checked={dupSel.has(d.pingId)} /></td>
                    <td className="num">{d.host}</td>
                    <td className="c-muted">{d.pingName}</td>
                    <td>{d.traceName}</td>
                    <td className="c-muted">{d.group}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>


      <div className="card">
        <h3>{t("Обмен конфигурацией")}</h3>
        <div className="desc">{t("Выгрузите список целей и настройки в файл и передайте коллегам — они импортируют его в свой NetPulse. Токены и пароли в файл не попадают.")}</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={async () => { try { const p = await api.exportConfig(withSettings); if (p) toast(`Сохранено: ${p}`, "ok"); } catch (e) { toast(String(e), "error"); } }}>{t("Экспорт в файл…")}</button>
          <Toggle checked={withSettings} onChange={setWithSettings} label={t("вместе с настройками оповещений")} />
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={async () => { try { const n = await api.importConfig(false); if (n != null) { toast(`Импортировано целей: ${n}`, "ok"); onImported(); api.settings().then((x) => { setS(x); setOrig(JSON.stringify(x)); }); } } catch (e) { toast(String(e), "error"); } }}>{t("Импорт (добавить и обновить)…")}</button>
          <button className="btn danger" onClick={async () => { if (!(await ask({ title: "Заменить все цели?", message: "Текущие цели будут удалены вместе с историей и заменены целями из файла.", confirm: "Заменить", danger: true }))) return; try { const n = await api.importConfig(true); if (n != null) { toast(`Импортировано целей: ${n}`, "ok"); onImported(); } } catch (e) { toast(String(e), "error"); } }}>{t("Импорт с заменой…")}</button>
        </div>
      </div>

        </>
      )}

      {tab === "updates" && (
        <>

      <div className="card">
        <h3>{t("Обновления")}</h3>
        <div className="desc">
          Программа сама проверяет новые версии и предлагает установить их в один клик — устанавливать вручную не нужно.
          {!updSource && <> <span className="c-warn">{t("не встроен в эту сборку")}</span></>}
        </div>
        <Toggle checked={s.autoUpdate} onChange={(v) => setS({ ...s, autoUpdate: v })} label={t("Проверять автоматически (при запуске и каждые 6 часов)")} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn" onClick={checkUpd} disabled={upd.state === "checking" || upd.state === "installing" || !updSource}>{upd.state === "checking" ? "Проверяю…" : "Проверить обновления"}</button>
          {upd.state === "none" && <span className="c-ok">У вас последняя версия{info ? ` (${info.version})` : ""}</span>}
          {upd.state === "error" && <span className="c-down">{upd.error}</span>}
          {(upd.state === "available" || upd.state === "installing") && upd.info && (
            <>
              <span>{t("Доступна версия")} <b className="c-ok">{upd.info.version}</b> <span className="c-muted">(у вас {upd.info.current})</span></span>
              <button className="btn primary" onClick={installUpd} disabled={upd.state === "installing"}>{upd.state === "installing" ? "Устанавливаю… программа перезапустится" : "Установить и перезапустить"}</button>
            </>
          )}
        </div>
        {upd.info?.notes && <div className="c-muted" style={{ fontSize: 12, marginTop: 8, whiteSpace: "pre-wrap" }}>{upd.info.notes}</div>}
      </div>

        </>
      )}

      {tab === "about" && (
        <>
      {info && (
        <div className="card">
          <h3>{t("О программе")}</h3>
          <div className="form-grid" style={{ marginTop: 10, fontSize: 12.5 }}>
            <div><span className="c-muted">{t("Версия:")} </span>NetPulse {info.version}</div>
            <div><span className="c-muted">{t("Автор:")} </span>Sorokin Maksim</div>
            {!info.icmpMode && <div className="field full"><span className="c-down">{t("Проверки ICMP недоступны")} — {info.icmpError}</span></div>}
            {info.icmpMode && !info.supportsTrace && <div className="field full"><span className="c-warn">{t("Трассировка маршрута недоступна")}</span></div>}
            <div className="field full"><span className="c-muted">{t("Данные:")} </span><span className="num" style={{ userSelect: "text" }}>{info.dataDir}</span></div>
          </div>
          {projectPage && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => api.openProjectPage().catch((e) => toast(String(e), "error"))}>{t("Страница проекта")}</button>
              <span className="c-muted" style={{ fontSize: 11.5 }}>{t("Исходный код, история версий и установочные файлы")}</span>
            </div>
          )}
        </div>
      )}


      <div className="card">
        <h3>{t("Журнал работы программы")}</h3>
        <div className="desc">{t("Технический журнал: ошибки записи в базу, сбои отправки уведомлений, недоступность ICMP. Пригодится, если что-то работает не так.")}</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={async () => { try { setLog(await api.appLog()); } catch (e) { toast(String(e), "error"); } }}>{t("Показать последние записи")}</button>
          {log !== null && <button className="btn ghost" onClick={() => setLog(null)}>{t("Скрыть")}</button>}
          {info?.logPath && <span className="c-muted num" style={{ fontSize: 11.5 }}>{info.logPath}</span>}
        </div>
        {log !== null && (
          <pre className="log-view">{log.trim() || "Журнал пока пуст."}</pre>
        )}
      </div>

        </>
      )}

      <div className="save-bar">
        <button className="btn primary" onClick={save} disabled={!dirty}>{t("Сохранить настройки")}</button>
        {dirty && <span className="c-warn">{t("Есть несохранённые изменения")}</span>}
      </div>
    </div>
  );
}

function isTauriLabel() {
  return isTauri ? (navigator.userAgent.includes("Mac") ? "Уведомления macOS" : "Уведомления Windows") : "Системные уведомления";
}
