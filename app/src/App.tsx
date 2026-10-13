import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { plural } from "./format";
import { setLang, t } from "./i18n";
import { api, isMac, isTauri } from "./api";
import type { EngineInfo, FeedItem, LicenseStatus, IncidentNotice, Target, TargetSummary, TargetTemplate, UpdateInfo } from "./types";
import { DEFAULT_GROUP, INCIDENT_KINDS } from "./types";
import { IncidentControl } from "./control";
import { IncidentToasts, NoticeBell, loadFeed, saveFeed, type IncToast } from "./components/Notices";
import { Dashboard } from "./pages/Dashboard";
import { TargetDetail } from "./pages/TargetDetail";
import { Incidents } from "./pages/Incidents";
import { Operators } from "./pages/Operators";
import { SettingsPage } from "./pages/SettingsPage";
import { Reports } from "./pages/Reports";
import { NetworkMap } from "./pages/NetworkMap";
import { Wallboard } from "./pages/Wallboard";
import { BulkEditModal, applyBulk } from "./components/Templates";
import type { BulkPatch } from "./components/Templates";
import { Compare } from "./pages/Compare";
import { TargetModal } from "./components/TargetModal";
import { Dot, Icon, Logo, stripMark } from "./components/ui";
import { ProGate, type ProFeature } from "./components/License";
import { beep } from "./sound";
import { applyTheme, currentTheme, type ThemeDef } from "./theme";
import { ask, askGroupDelete, askText, ConfirmHost, ContextMenu, GroupDeleteHost, PromptHost } from "./components/Dialogs";
import type { MenuItem } from "./components/Dialogs";

type Page = { name: "dashboard" } | { name: "target"; id: string; at?: number } | { name: "events"; tab?: { tab: "open" | "history" | "journal" } } | { name: "operators"; target?: string } | { name: "settings"; tab?: "license" } | { name: "reports" } | { name: "compare" } | { name: "wallboard" } | { name: "map" };
interface Toast { id: number; msg: string; kind: string }

export default function App() {
  const [page, setPage] = useState<Page>({ name: "dashboard" });
  const [group, setGroup] = useState<string | null>(null);
  const [items, setItems] = useState<TargetSummary[]>([]);
  const [modal, setModal] = useState<Target | null | undefined>(undefined);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [unread, setUnread] = useState(0);
  const [controlSet, setControl] = useState(false);
  const [lic, setLic] = useState<LicenseStatus | null>(null);
  // Пока статус не пришёл — ничего не запираем, чтобы не мигало.
  const pro = lic?.licensed ?? true;
  const control = controlSet && pro;
  const [feed, setFeed] = useState<FeedItem[]>(() => loadFeed());
  const [incToasts, setIncToasts] = useState<IncToast[]>([]);
  const pushFeed = useCallback((f: FeedItem) => setFeed((cur) => { const n = [f, ...cur].slice(0, 60); saveFeed(n); return n; }), []);
  const [openInc, setOpenInc] = useState(0);
  useEffect(() => {
    const load = () => api.incidents(Date.now(), Date.now() + 1, 200).then((l) => setOpenInc(l.filter((i) => i.closed == null).length)).catch(() => {});
    load();
    const h = setInterval(load, 5000);
    return () => clearInterval(h);
  }, []);
  const [refreshKey, setRefreshKey] = useState(0);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kiosk, setKiosk] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("np.sideCollapsed") === "1"; } catch { return false; } });
  const toggleSide = () => setCollapsed((v) => { try { localStorage.setItem("np.sideCollapsed", v ? "0" : "1"); } catch { /* */ } return !v; });
  const [bulk, setBulk] = useState<{ targets: Target[]; templates: TargetTemplate[] } | null>(null);
  const onSelect = useCallback((ids: string[], on: boolean) => setSelected((cur) => {
    const n = new Set(cur);
    ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
    return n;
  }), []);
  const openBulk = async () => {
    const [targets, s] = await Promise.all([api.listTargets(), api.settings()]);
    setBulk({ targets, templates: s.templates ?? [] });
  };
  const applyBulkPatch = async (p: BulkPatch) => {
    if (!bulk) return;
    let ok = 0;
    const errors: string[] = [];
    for (const t of bulk.targets.filter((x) => selected.has(x.id))) {
      try {
        await api.saveTarget(applyBulk(t, p, bulk.templates));
        ok++;
      } catch (e) {
        errors.push(`${t.name}: ${e}`);
      }
    }
    setBulk(null);
    toast(`Изменено целей: ${ok}${errors.length ? `, ошибок: ${errors.length} (${errors[0]})` : ""}`, errors.length ? "error" : "ok");
    refresh();
  };
  const deleteSelected = async () => {
    const ids = [...selected];
    if (!(await ask({ title: `Удалить ${plural(ids.length, "цель", "цели", "целей")}?`, message: "Цели и вся их история будут удалены без возможности восстановления.", confirm: "Удалить", danger: true }))) return;
    for (const id of ids) await api.deleteTarget(id).catch(() => {});
    setBulk(null);
    setSelected(new Set());
    toast(`Удалено целей: ${ids.length}`, "ok");
    refresh();
  };
  const [installing, setInstalling] = useState(false);
  const toastId = useRef(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [groupNames, setGroupNames] = useState<string[]>([]);
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<{ g: string; after: boolean } | null>(null);

  const toast = useCallback((msg: string, kind = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-4), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" || kind === "critical" ? 9000 : 5000);
  }, []);

  const refresh = useCallback(
    () => Promise.all([api.summaries(), api.listGroups()]).then(([s, g]) => { setItems(s); setGroupNames(g); }).catch(() => {}),
    [],
  );
  useEffect(() => { api.licenseStatus().then(setLic).catch(() => {}); }, [items.length]);
  const openLicense = () => setPage({ name: "settings", tab: "license" });
  // Новая цель: в бесплатной версии — не больше лимита.
  const addTarget = async () => {
    if (lic && !lic.licensed && items.length >= lic.targetLimit) {
      if (await ask({ title: t("Бесплатная версия — до") + ` ${lic.targetLimit} ` + t("узлов"), message: t("Чтобы следить за большим числом узлов, введите ключ полной версии."), confirm: t("Ввести ключ") })) openLicense();
      return;
    }
    setModal(null);
  };
  const gate = (f: ProFeature) => <ProGate feature={f} lic={lic} onLicense={setLic} toast={toast} />;

  // Язык интерфейса берём из настроек: перерисовка идёт через состояние lang.
  const [lang, setLangState] = useState<string>("ru");
  // Тема применена ещё до первой отрисовки (main.tsx); из настроек — окончательно.
  const [theme, setThemeState] = useState<ThemeDef>(() => currentTheme());
  const changeTheme = useCallback((id: string) => setThemeState(applyTheme(id)), []);
  const [dbWarnHidden, setDbWarnHidden] = useState(false);
  useEffect(() => {
    api.settings().then((s) => { setControl(!!s.incidentControl); setLang(s.language); setLangState(s.language); if (s.theme && s.theme !== currentTheme().id) changeTheme(s.theme); }).catch(() => {});
  }, [refreshKey]);

  useEffect(() => {
    refresh();
    api.engineInfo().then(setInfo).catch(() => {});
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh, refreshKey]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    api.onAlert((p) => {
      if (p.alert.silent) return; // режим тишины: только журнал
      // Недоступность, потери и восстановления сообщаются одним уведомлением инцидента.
      if (p.viaIncident ?? INCIDENT_KINDS.includes(p.alert.kind)) return;
      toast(stripMark(p.alert.message), p.alert.severity);
      if (p.sound) beep(p.alert.severity);
      if (p.alert.notify && p.alert.kind !== "test") {
        const [title, ...rest] = stripMark(p.alert.message).split("\n");
        pushFeed({ id: `a${Date.now()}${Math.random()}`, ts: Date.now(), title, body: rest.join(" "), severity: p.alert.severity, targetId: p.alert.targetId || undefined });
        setUnread((n) => n + 1);
      }
    }).then((f) => { if (dead) f(); else off = f; });
    return () => { dead = true; off?.(); };
  }, [toast, pushFeed]);

  const incKey = useRef(0);
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    api.onIncident(({ notice: n, sound }) => {
      const key = ++incKey.current;
      setIncToasts((cur) => [...cur.filter((x) => x.notice.incident.id !== n.incident.id).slice(-2), { key, notice: n }]);
      setTimeout(() => setIncToasts((cur) => cur.filter((x) => x.key !== key)), n.severity === "critical" && n.event !== "close" ? 20000 : 9000);
      if (sound) beep(n.severity === "ok" ? "ok" : n.severity);
      pushFeed({ id: `i${key}${Date.now()}`, ts: Date.now(), title: n.title, body: n.body.split("\n").slice(0, 2).join(" · "), severity: n.severity, incidentId: n.incident.id, event: n.event });
      setUnread((c) => c + 1);
    }).then((f) => { if (dead) f(); else off = f; });
    return () => { dead = true; off?.(); };
  }, [pushFeed]);
  const openIncidents = () => { setUnread(0); setPage({ name: "events", tab: { tab: "open" } }); };
  const openNotice = (n: IncidentNotice) => {
    if (n.event === "close" && n.incident.targets[0]) setPage({ name: "events", tab: { tab: "history" } });
    else openIncidents();
  };

  useEffect(() => {
    let off: (() => void) | undefined;
    api.onUpdate(setUpdate).then((f) => (off = f));
    return () => off?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); void addTarget(); }
      if (mod && e.key === ",") { e.preventDefault(); setPage({ name: "settings" }); }
      if (e.key === "Escape" && page.name === "target" && modal === undefined) setPage({ name: "dashboard" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, modal, lic, items.length]);

  // Группы в порядке пользователя, включая пустые. «Общее» — буфер для целей без группы:
  // в боковой панели показывается, только когда в ней есть цели.
  const groups = useMemo(() => {
    const m = new Map<string, TargetSummary[]>();
    m.set(DEFAULT_GROUP, []);
    groupNames.forEach((g) => m.set(g, []));
    items.forEach((i) => { if (!m.has(i.group)) m.set(i.group, []); m.get(i.group)!.push(i); });
    return [...m.entries()];
  }, [items, groupNames]);

  const downCount = items.filter((i) => i.health === "down").length;
  const worst = (list: TargetSummary[]) =>
    !list.length ? "unknown" : list.some((i) => i.health === "down") ? "down" : list.some((i) => i.health === "dependent") ? "dependent" : list.some((i) => i.health === "crit") ? "crit" : list.some((i) => i.health === "bad") ? "bad" : list.some((i) => i.health === "warn") ? "warn" : list.every((i) => i.health === "paused") ? "paused" : "ok";

  useEffect(() => {
    document.title = downCount ? `(${downCount}) NetPulse` : "NetPulse";
  }, [downCount]);

  const open = (id: string, at?: number) => setPage({ name: "target", id, at });
  const toggleMute = async (id: string) => {
    const t = (await api.listTargets()).find((x) => x.id === id);
    if (!t) return;
    await api.saveTarget({ ...t, alertsEnabled: !t.alertsEnabled });
    toast(t.alertsEnabled ? `«${t.name}»: режим тишины — события пишутся, уведомлений не будет` : `«${t.name}»: уведомления включены`, "ok");
    refresh();
  };

  const onContext = (e: React.MouseEvent, s: TargetSummary) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items: menuItems(s) });
  };

  // ------------------------------------------------------------ группы
  const groupExists = (name: string, except?: string) =>
    groups.some(([g]) => g !== except && g.toLowerCase() === name.trim().toLowerCase());

  const addGroup = async () => {
    const name = await askText({
      title: "Новая группа",
      label: "Название",
      placeholder: "Например: Главный офис",
      confirm: "Создать",
      validate: (v) => (!v.trim() ? "введите название" : groupExists(v) ? "такая группа уже есть" : null),
    });
    if (!name) return;
    try {
      const n = await api.addGroup(name);
      await refresh();
      setGroup(n);
      setPage({ name: "dashboard" });
      toast(`Группа «${n}» создана`, "ok");
    } catch (err) {
      toast(String(err), "error");
    }
  };

  const renameGroup = async (old: string) => {
    const name = await askText({
      title: "Переименовать группу",
      label: "Новое название",
      value: old,
      confirm: "Сохранить",
      validate: (v) => (!v.trim() ? "введите название" : null),
    });
    if (!name || name === old) return;
    const merge = groupExists(name, old);
    if (merge && !(await ask({ title: `Объединить с группой «${name}»?`, message: `Группа с таким названием уже есть. Цели из «${old}» будут перенесены в неё.`, confirm: "Объединить" }))) return;
    try {
      const n = await api.renameGroup(old, name);
      if (group === old) setGroup(n);
      await refresh();
      toast(merge ? `Группы объединены в «${n}»` : `Группа переименована в «${n}»`, "ok");
    } catch (err) {
      toast(String(err), "error");
    }
  };

  const deleteGroup = async (name: string) => {
    const list = groups.find(([g]) => g === name)?.[1] ?? [];
    const choice = await askGroupDelete({ name, count: list.length, others: groups.map(([g]) => g).filter((g) => g !== name) });
    if (!choice) return;
    try {
      await api.deleteGroup(name, "moveTo" in choice ? choice.moveTo || null : null);
      if (group === name) setGroup(null);
      await refresh();
      toast(`Группа «${name}» удалена`, "ok");
    } catch (err) {
      toast(String(err), "error");
    }
  };

  const moveTargets = async (ids: string[], dest: string) => {
    try {
      await api.moveToGroup(ids, dest);
      await refresh();
      toast(ids.length === 1 ? `Цель перенесена в «${dest}»` : `Перенесено целей: ${ids.length}`, "ok");
    } catch (err) {
      toast(String(err), "error");
    }
  };

  // Перетаскивание групп для сортировки по важности.
  const reorderGroups = async (dragged: string, target: string, after: boolean) => {
    const names = groups.map(([g]) => g).filter((g) => g !== DEFAULT_GROUP && g !== dragged);
    let at = target === DEFAULT_GROUP ? 0 : names.indexOf(target) + (after ? 1 : 0);
    if (at < 0) at = names.length;
    names.splice(at, 0, dragged);
    const next = [DEFAULT_GROUP, ...names];
    setGroupNames(next);
    try {
      await api.reorderGroups(next);
    } catch (err) {
      toast(String(err), "error");
      refresh();
    }
  };

  const onGroupContext = (e: React.MouseEvent, g: string) => {
    e.preventDefault();
    e.stopPropagation();
    const isDefault = g === DEFAULT_GROUP;
    const members = groups.find(([x]) => x === g)?.[1] ?? [];
    const count = members.length;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Открыть", onClick: () => { setGroup(g); setPage({ name: "dashboard" }); } },
        { label: t("Добавить цель в группу…"), onClick: () => { setGroup(g); void addTarget(); } },
        { label: "Переименовать…", disabled: isDefault, hint: isDefault ? "по умолчанию" : undefined, onClick: () => renameGroup(g) },
        { label: "Приостановить все цели", disabled: !count, onClick: () => Promise.all(members.filter((i) => i.enabled).map((i) => api.setEnabled(i.id, false))).then(refresh) },
        { label: "Запустить все цели", disabled: !count, onClick: () => Promise.all(members.filter((i) => !i.enabled).map((i) => api.setEnabled(i.id, true))).then(refresh) },
        { label: "", separator: true },
        { label: "Новая группа…", onClick: addGroup },
        { label: "Удалить группу…", danger: true, disabled: isDefault, onClick: () => deleteGroup(g) },
      ],
    });
  };

  const removeTarget = async (s: TargetSummary) => {
    const ok = await ask({
      title: `Удалить «${s.name}»?`,
      message: <>Цель <span className="num">{s.host}</span> и вся её история будут удалены без возможности восстановления.</>,
      confirm: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteTarget(s.id);
      if (page.name === "target" && page.id === s.id) setPage({ name: "dashboard" });
      toast(`«${s.name}» удалена`, "ok");
      refresh();
    } catch (err) {
      toast(String(err), "error");
    }
  };

  const menuItems = (s: TargetSummary) => [
    { label: "Открыть", onClick: () => open(s.id) },
    { label: s.alertsEnabled ? "Выключить уведомления" : "Включить уведомления", onClick: () => toggleMute(s.id) },
    { label: "Настроить…", onClick: async () => { const t = (await api.listTargets()).find((x) => x.id === s.id); if (t) setModal(t); } },
    { label: s.enabled ? "Поставить на паузу" : "Запустить", onClick: () => api.setEnabled(s.id, !s.enabled).then(refresh) },
    {
      label: "Переместить в группу…",
      hint: s.group,
      onClick: async () => {
        const NEW = "+ Новая группа…";
        const others = groups.map(([g]) => g).filter((g) => g !== s.group);
        let dest = await askText({ title: `Переместить «${s.name}»`, label: "В группу", options: [...others, NEW], confirm: "Переместить" });
        if (dest === NEW) {
          dest = await askText({ title: "Новая группа", label: "Название", confirm: "Создать и переместить", validate: (v) => (groupExists(v) ? "такая группа уже есть" : null) });
        }
        if (dest) moveTargets([s.id], dest);
      },
    },
    { label: "Копировать адрес", hint: s.host, onClick: () => void navigator.clipboard?.writeText(s.host).then(() => toast("Адрес скопирован")).catch(() => toast("Не удалось скопировать адрес", "error")) },
    { label: "", separator: true },
    { label: "Удалить…", danger: true, onClick: () => removeTarget(s) },
  ];

  // Кнопка группы: в боковой панели — список, в верхнем меню — полоса (порядок меняется перетаскиванием).
  const groupBtn = (g: string, list: TargetSummary[], horizontal: boolean) => {
            const isDefault = g === DEFAULT_GROUP;
            const mark = dropMark?.g === g ? (dropMark.after ? " drop-after" : " drop-before") : "";
            return (
              <button
                key={g}
                className={(page.name === "dashboard" && group === g ? "active" : "") + (dropGroup === g ? " drop-over" : "") + mark + (dragGroup === g ? " dragging" : "")}
                onClick={() => { setGroup(g); setPage({ name: "dashboard" }); }}
                onContextMenu={(e) => onGroupContext(e, g)}
                onDoubleClick={() => !isDefault && renameGroup(g)}
                draggable={!isDefault}
                onDragStart={(e) => { e.dataTransfer.setData("text/netpulse-group", g); e.dataTransfer.effectAllowed = "move"; setDragGroup(g); }}
                onDragEnd={() => { setDragGroup(null); setDropMark(null); setDropGroup(null); }}
                onDragOver={(e) => {
                  if (dragGroup) {
                    if (dragGroup === g) return setDropMark(null);
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    const after = isDefault ? true : horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
                    if (dropMark?.g !== g || dropMark.after !== after) setDropMark({ g, after });
                  } else if (e.dataTransfer.types.includes("text/netpulse-target")) {
                    e.preventDefault();
                    setDropGroup(g);
                  }
                }}
                onDragLeave={() => { setDropGroup(null); setDropMark(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragGroup) {
                    const after = dropMark?.after ?? true;
                    const dragged = dragGroup;
                    setDragGroup(null);
                    setDropMark(null);
                    if (dragged !== g) reorderGroups(dragged, g, after);
                    return;
                  }
                  setDropGroup(null);
                  const id = e.dataTransfer.getData("text/netpulse-target");
                  const s = items.find((x) => x.id === id);
                  if (s && s.group !== g) moveTargets([id], g);
                }}
                title={`${g} (${list.length})\n` + (isDefault ? "Цели без группы. Скрывается, когда пустая" : "Перетащите, чтобы изменить порядок · правая кнопка — меню · двойной клик — переименовать")}
              >
                <Dot h={worst(list)} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{g}</span>
                <span className="badge">{list.length}</span>
              </button>
            );
  };
  const visibleGroups = groups.filter(([g, list]) => g !== DEFAULT_GROUP || list.length > 0);

  // Разделы программы — одни и те же в боковой панели и в верхнем меню.
  const lock = pro ? null : <span className="nav-lock" title={t("В полной версии")}><Icon name="lock" size={11} /></span>;
  const navButtons = (topNav: boolean) => (
    <>
          <button title="Все цели" className={page.name === "dashboard" && !group ? "active" : ""} onClick={() => { setGroup(null); setPage({ name: "dashboard" }); }}>
            {!topNav && <Icon name="grid" />} {t("Все цели")} <span className="badge">{items.length}</span>
          </button>
          <button title="Дашборд" className={page.name === "wallboard" ? "active" : ""} onClick={() => setPage({ name: "wallboard" })}>
            {!topNav && <Icon name="tiles" />} {t("Дашборд")}{lock}
          </button>
          <button title="Инциденты" className={page.name === "events" ? "active" : ""} onClick={() => { setUnread(0); setPage({ name: "events" }); }}>
            {!topNav && <Icon name="bell" />} {t("Инциденты")}{lock} {control && openInc > 0 ? <span className="badge red">{openInc}</span> : unread > 0 && <span className="badge">{unread}</span>}
          </button>
          <button title="Сравнение" className={page.name === "compare" ? "active" : ""} onClick={() => setPage({ name: "compare" })}>
            {!topNav && <Icon name="chart" />} {t("Сравнение")}
          </button>
          <button title="Карта сети" className={page.name === "map" ? "active" : ""} onClick={() => setPage({ name: "map" })}>
            {!topNav && <Icon name="map" />} {t("Карта сети")} <span className="beta">beta</span>{lock}
          </button>
          <button title="Отчёты" className={page.name === "reports" ? "active" : ""} onClick={() => setPage({ name: "reports" })}>
            {!topNav && <Icon name="report" />} {t("Отчёты")}{lock}
          </button>
          <button title="Операторы" className={page.name === "operators" ? "active" : ""} onClick={() => setPage({ name: "operators" })}>
            {!topNav && <Icon name="phone" />} {t("Операторы")}{lock}
          </button>
          {!topNav && (
            <button title="Настройки" className={page.name === "settings" ? "active" : ""} onClick={() => setPage({ name: "settings" })}>
              <Icon name="gear" /> {t("Настройки")}
            </button>
          )}
    </>
  );
  const top = theme.layout === "top";

  void lang; // перерисовка при смене языка
  return (
    <IncidentControl.Provider value={control}>
    <div className={"app" + (kiosk && page.name === "wallboard" ? " kiosk" : "") + (collapsed && !top ? " collapsed" : "") + (top ? " top" : "") + (isMac && isTauri ? " mac" : "")}>
      {top && (
        <header className="tnav" data-tauri-drag-region onMouseDown={(e) => e.target === e.currentTarget && e.buttons === 1 && e.detail === 1 && api.startDragging()}>
          <div className="tnav-brand" onMouseDown={(e) => e.buttons === 1 && e.detail === 1 && api.startDragging()}>
            <div className="brand-logo"><Logo /></div>
            <b>NetPulse</b>
          </div>
          <nav className="tnav-nav">{navButtons(true)}</nav>
          <div className="tnav-fill" data-tauri-drag-region onMouseDown={(e) => e.buttons === 1 && e.detail === 1 && api.startDragging()} />
          <div className="tnav-tools">
            <span className="tnav-engine" title={info ? (info.icmpError ? "ICMP недоступен" : `${t("Движок работает")} · v${info.version}`) : ""}>
              <span className={"dot " + (info?.icmpError ? "down" : "ok")} style={{ width: 7, height: 7 }} />
              <span>{info ? `v${info.version}` : "…"}</span>
            </span>
            <NoticeBell
              feed={feed}
              unread={unread}
              onSeen={() => { setUnread(0); setIncToasts([]); }}
              onClear={() => { setFeed([]); saveFeed([]); }}
              onPick={(f) => (f.incidentId ? setPage({ name: "events", tab: { tab: f.event === "close" ? "history" : "open" } }) : f.targetId ? open(f.targetId) : openIncidents())}
              onAll={openIncidents}
            />
            <button className={"tnav-ico" + (page.name === "settings" ? " on" : "")} title={t("Настройки")} onClick={() => setPage({ name: "settings" })}>
              <Icon name="gear" size={16} />
            </button>
          </div>
        </header>
      )}
      {!top && <aside className={"sidebar" + (isMac || !isTauri ? "" : " win")}>
        <div className="drag" data-tauri-drag-region onMouseDown={(e) => e.buttons === 1 && e.detail === 1 && api.startDragging()} />
        <div className="brand">
          <div className="brand-logo"><Logo /></div>
          <div className="brand-text"><b>NetPulse</b><small>мониторинг сети</small></div>
          <button className="side-toggle" onClick={toggleSide} title={collapsed ? "Развернуть панель" : "Свернуть панель"}>
            <Icon name={collapsed ? "expand" : "collapse"} size={14} />
          </button>
        </div>
        <nav className="nav">{navButtons(false)}</nav>
        <div className="side-head">
          <div className="side-title">{t("Группы")}</div>
          <button className="side-add" title="Новая группа" onClick={addGroup}><Icon name="plus" size={14} /></button>
        </div>
        <div className="groups nav">
          {visibleGroups.map(([g, list]) => groupBtn(g, list, false))}
          {page.name === "target" && (
            <>
              <div className="side-title" style={{ paddingLeft: 10 }}>{t("Цели")}</div>
              {items.map((i) => (
                <button key={i.id} className={page.id === i.id ? "active" : ""} onClick={() => open(i.id)} onContextMenu={(e) => onContext(e, i)}>
                  <Dot h={i.health} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
        <div className="side-foot">
          <span className={"dot " + (info?.icmpError ? "down" : "ok")} style={{ width: 7, height: 7 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {info ? (info.icmpError ? "ICMP недоступен" : `${t("Движок работает")} · v${info.version}`) : "…"}
          </span>
        </div>
      </aside>}

      <main className="main">
        {top && page.name === "dashboard" && (
          <div className="grpbar">
            <button className={!group ? "active" : ""} onClick={() => setGroup(null)}>{t("Все")}<span className="badge">{items.length}</span></button>
            {visibleGroups.map(([g, list]) => groupBtn(g, list, true))}
            <button className="grp-add" title={t("Новая группа")} onClick={addGroup}><Icon name="plus" size={13} /></button>
          </div>
        )}
        {!top && <div data-tauri-drag-region style={{ height: isTauri && isMac ? 14 : 0, flex: "none" }} />}
        {update && (
          <div className="update-banner">
            <span>Доступна новая версия NetPulse <b className="c-ok">{update.version}</b> <span className="c-muted">(у вас {update.current})</span></span>
            <span style={{ flex: 1 }} />
            <button className="btn primary sm" disabled={installing} onClick={async () => { setInstalling(true); try { await api.installUpdate(); } catch (e) { toast(String(e), "error"); setInstalling(false); } }}>{installing ? "Устанавливаю…" : "Установить и перезапустить"}</button>
            <button className="btn ghost sm" onClick={() => setUpdate(null)}>Позже</button>
          </div>
        )}
        {info?.dbWarning && !dbWarnHidden && (
          <div className="banner db-warning">
            {info.dbWarning}
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm" onClick={() => setDbWarnHidden(true)}>{t("Закрыть")}</button>
          </div>
        )}
        {info?.icmpError && page.name === "dashboard" && (
          <div className="banner">Не удалось открыть ICMP-сокет: {info.icmpError}. Проверки HTTP, TCP и DNS продолжают работать.</div>
        )}
        <div className="content" key={theme.id}>
          {page.name === "dashboard" && (
            <Dashboard items={items} group={group} onOpen={open} onAdd={() => void addTarget()} onToggle={(s) => api.setEnabled(s.id, !s.enabled).then(refresh)} onContext={onContext} groupOrder={groups.map(([g]) => g)} selected={selected} onSelect={onSelect} onBulk={openBulk} />
          )}
          {page.name === "target" && (
            <TargetDetail
              key={`${page.id}-${page.at ?? ""}`}
              id={page.id}
              at={page.at}
              onToggleMute={() => toggleMute(page.id)}
              summary={items.find((i) => i.id === page.id)}
              onBack={() => setPage({ name: "dashboard" })}
              onEdit={(t) => setModal(t)}
              onDeleted={() => { setPage({ name: "dashboard" }); refresh(); }}
              toast={toast}
              onOperators={(tid) => setPage({ name: "operators", target: tid })}
            />
          )}
          {page.name === "events" && !pro && gate("events")}
          {page.name === "events" && pro && <Incidents tabReq={page.tab} items={items} onOpen={open} refreshKey={refreshKey} toast={toast} onOperators={(tid) => setPage({ name: "operators", target: tid })} />}
          {page.name === "operators" && !pro && gate("operators")}
          {page.name === "operators" && pro && <Operators items={items} groups={groupNames} toast={toast} onOpen={open} focusTarget={page.target ?? null} onFocusDone={() => setPage({ name: "operators" })} />}
          {page.name === "reports" && !pro && gate("reports")}
          {page.name === "reports" && pro && <Reports onOpen={open} toast={toast} />}
          {page.name === "wallboard" && !pro && gate("wallboard")}
          {page.name === "wallboard" && pro && <Wallboard items={items} onOpen={(id) => { if (kiosk) { setKiosk(false); api.setFullscreen(false).catch(() => {}); } open(id); }} onExit={() => setPage({ name: "dashboard" })} kiosk={kiosk} onKiosk={(v) => { setKiosk(v); if (!v) api.setFullscreen(false).catch(() => {}); }} />}
          {page.name === "map" && !pro && gate("map")}
          {page.name === "map" && pro && <NetworkMap items={items} groups={groupNames} onOpen={open} toast={toast} />}
          {page.name === "compare" && <Compare items={items} onOpen={open} />}
          {page.name === "settings" && <SettingsPage tabReq={page.tab} lic={lic} onLicense={setLic} toast={toast} onImported={() => setRefreshKey((k) => k + 1)} theme={theme.id} onTheme={changeTheme} />}
        </div>
      </main>

      {modal !== undefined && (
        <TargetModal
          initial={modal}
          groups={groups.map(([g]) => g)}
          defaultGroup={group}
          onClose={() => setModal(undefined)}
          onSaved={(m) => { toast(m, "ok"); refresh(); }}
        />
      )}

      {bulk && (
        <BulkEditModal
          count={selected.size}
          targets={bulk.targets}
          groups={groups.map(([g]) => g)}
          templates={bulk.templates}
          onApply={applyBulkPatch}
          onDelete={deleteSelected}
          onClose={() => setBulk(null)}
        />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <ConfirmHost />
      <PromptHost />
      <GroupDeleteHost />

      <IncidentToasts list={incToasts} onClose={(k) => setIncToasts((c) => c.filter((x) => x.key !== k))} onOpen={openNotice} toast={toast} />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={"toast " + t.kind} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>{t.msg}</div>
        ))}
      </div>
    </div>
    </IncidentControl.Provider>
  );
}
