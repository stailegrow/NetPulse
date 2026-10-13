import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TargetOperator, CheckKind, ScanDevice, ScanProgress, ScanResult, SubnetHint, TargetSummary, Topology } from "../types";
import { defaultTarget, KIND_LABEL } from "../types";
import { api } from "../api";
import { fmtDateTime, fmtMs, fmtPct, plural } from "../format";
import { problemText } from "../problem";
import { t } from "../i18n";
import { cv } from "../theme";
import { NODE_TYPES, NodeGlyph, NodeIcon, type NodeType } from "../map/icons";
import { buildGraph, cubicPts, DIM, inOf, nodeRect, outOf, parseLayout, smooth, splitAt, ST_COLOR, ZONE, type Bead, type Dir, type GEdge, type GNode, type Graph, type Layout, type NodeCfg, type P, type Rect, type St, type Zone } from "../map/graph";

const MIN_K = 0.12;
const MAX_K = 3;
const TOPO_EVERY_MS = 8000;
const PROGRESS_EVERY_MS = 700;

interface View { k: number; tx: number; ty: number }
type Drag = { kind: "node" | "zone"; key: string; sx: number; sy: number; dx: number; dy: number; moved: boolean; pick?: string };
type Pan = { x: number; y: number; tx: number; ty: number; moved: boolean; pick?: string };
type Side = { kind: "found"; subnet: string | null } | { kind: "hidden" } | null;

const DEVICE_KIND: Record<string, string> = {
  router: "Маршрутизатор", switch: "Коммутатор", firewall: "Межсетевой экран", wifi: "Точка доступа Wi-Fi",
  server: "Сервер", hypervisor: "Гипервизор", storage: "Хранилище", pc: "Компьютер", phone: "IP-телефон",
  camera: "Камера", printer: "Принтер / МФУ", ups: "ИБП", device: "Устройство",
};
const asNodeType = (k: string | null | undefined): NodeType => (k && NODE_TYPES.some((x) => x.k === k) ? (k as NodeType) : "device");

/**
 * Карта сети: дерево от этого компьютера к целям. Пути берутся из скана сети (кнопка
 * «Сканировать сеть»), адреса одного устройства склеены, весь внешний интернет — один узел.
 * Цвет отрезка показывает, доходят ли пакеты до этой точки: обрыв виден там, где он есть.
 */
export function NetworkMap({ items, groups, onOpen, toast }: {
  items: TargetSummary[];
  /** Все группы (и пустые). */
  groups: string[];
  onOpen: (id: string) => void;
  toast: (msg: string, kind?: "ok" | "error") => void;
}) {
  const [topo, setTopo] = useState<Topology | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [view, setView] = useState<View>({ k: 1, tx: 80, ty: 80 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pan, setPan] = useState<Pan | null>(null);
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState(false);
  const [gear, setGear] = useState(false);
  const [side, setSide] = useState<Side>(null);
  const [scanDlg, setScanDlg] = useState(false);
  const [prog, setProg] = useState<ScanProgress | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = () => api.topology().then((x) => alive && setTopo(x)).catch(() => {});
    load();
    const id = setInterval(load, TOPO_EVERY_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);
  useEffect(() => {
    api.mapLayout().then((j) => setLayout(parseLayout(j))).catch(() => setLayout(parseLayout(null)));
    api.scanLast().then(setScan).catch(() => {});
    api.scanProgress().then((p) => p.running && setProg(p)).catch(() => {});
  }, []);

  // Пока идёт скан — опрашиваем ход; по окончании подхватываем результат.
  const running = !!prog?.running;
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const id = setInterval(() => {
      api.scanProgress().then((p) => {
        if (!alive) return;
        setProg(p);
        if (!p.running) {
          if (p.error) toast(`${t("Скан не завершён")}: ${p.error}`, "error");
          api.scanLast().then((s) => {
            setScan(s);
            if (s && !p.error) {
              const found = s.devices.filter((d) => !d.targetId).length;
              toast(`${t("Скан завершён")}: ${plural(s.traces.length, "маршрут", "маршрута", "маршрутов")}, ${plural(s.devices.length, "устройство", "устройства", "устройств")}${found ? ` · ${t("не в мониторинге")}: ${found}` : ""}`);
            }
          }).catch(() => {});
          fitted.current = false;
        }
      }).catch(() => {});
    }, PROGRESS_EVERY_MS);
    return () => { alive = false; clearInterval(id); };
  }, [running, toast]);

  const ready = layout != null;
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ready]);

  // Раскладку сохраняем с задержкой: перетаскивание не должно писать в базу на каждый пиксель.
  const saveTimer = useRef<number | undefined>(undefined);
  const update = useCallback((fn: (l: Layout) => Layout) => {
    setLayout((cur) => {
      if (!cur) return cur;
      const next = fn(structuredClone(cur));
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        api.saveMapLayout(JSON.stringify(next)).catch((e) => toast(String(e), "error"));
      }, 500);
      return next;
    });
  }, [toast]);
  const setNode = useCallback((key: string, patch: Partial<NodeCfg>) =>
    update((l) => {
      const c = { ...(l.nodes[key] ?? {}), ...patch };
      for (const k of Object.keys(c) as (keyof NodeCfg)[]) if (c[k] === undefined || c[k] === "") delete c[k];
      if (Object.keys(c).length) l.nodes[key] = c; else delete l.nodes[key];
      return l;
    }), [update]);

  const graph = useMemo(() => (layout ? buildGraph(topo, scan, items, layout) : null), [topo, scan, items, layout]);
  const devByIp = useMemo(() => new Map((scan?.devices ?? []).map((d) => [d.ip, d])), [scan]);

  // Во время перетаскивания двигаем поверх раскладки, в базу — по отпусканию.
  const pos = (n: { key: string; kind?: string; x: number; y: number; site?: string }) => {
    if (!drag || !drag.moved) return { x: n.x, y: n.y };
    if (drag.kind === "node" && drag.key === n.key) return { x: n.x + drag.dx, y: n.y + drag.dy };
    if (drag.kind === "zone" && n.site === drag.key && n.kind !== "zone") return { x: n.x + drag.dx, y: n.y + drag.dy };
    return { x: n.x, y: n.y };
  };
  const zoneShift = (z: Zone) => (drag?.kind === "zone" && drag.moved && z.site === drag.key ? { dx: drag.dx, dy: drag.dy } : { dx: 0, dy: 0 });

  const fit = useCallback(() => {
    if (!graph) return;
    const { x0, y0, x1, y1 } = graph.bounds;
    const pad = 60;
    const k = Math.min(1.4, Math.max(MIN_K, Math.min(size.w / (x1 - x0 + pad * 2), size.h / (y1 - y0 + pad * 2))));
    setView({ k, tx: (size.w - (x1 + x0) * k) / 2, ty: (size.h - (y1 + y0) * k) / 2 });
  }, [graph, size]);
  useEffect(() => {
    if (!fitted.current && graph && graph.nodes.length > 1 && size.w > 100 && size.h > 100) {
      fitted.current = true;
      fit();
    }
  }, [graph, size, fit]);

  const toWorld = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.tx) / view.k, y: (cy - r.top - view.ty) / view.k };
  };
  const zoomAt = (factor: number) =>
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      const px = size.w / 2, py = size.h / 2;
      return { k, tx: px - ((px - v.tx) * k) / v.k, ty: py - ((py - v.ty) * k) / v.k };
    });
  const centerOn = (x: number, y: number) => setView((v) => { const k = Math.max(v.k, 0.9); return { k, tx: size.w / 2 - x * k, ty: size.h / 2 - y * k }; });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * f));
        return { k, tx: px - ((px - v.tx) * k) / v.k, ty: py - ((py - v.ty) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ready]);

  const pick = (key: string) => {
    setSel(key);
    if (key.startsWith("found:")) setSide({ kind: "found", subnet: key.slice(6) });
    else setSide(null);
  };
  // Узлы двигаются только в режиме правки; в обычном режиме нажатие на узел — выбор, протяжка — сдвиг карты.
  const startDrag = (kind: Drag["kind"], key: string, e: React.MouseEvent, pickKey?: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const sel0 = pickKey ?? (kind === "zone" ? "zone:" + key : key);
    if (!edit) {
      setPan({ x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false, pick: sel0 });
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    setDrag({ kind, key, sx: w.x, sy: w.y, dx: 0, dy: 0, moved: false, pick: sel0 });
  };
  const onMove = (e: React.MouseEvent) => {
    if (drag) {
      const w = toWorld(e.clientX, e.clientY);
      const dx = w.x - drag.sx, dy = w.y - drag.sy;
      setDrag({ ...drag, dx, dy, moved: drag.moved || Math.abs(dx) + Math.abs(dy) > 2 / view.k });
    } else if (pan) {
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      setView((v) => ({ ...v, tx: pan.tx + dx, ty: pan.ty + dy }));
      if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 3) setPan({ ...pan, moved: true });
    }
  };
  const onUp = () => {
    if (drag && graph && layout) {
      if (!drag.moved) pick(drag.pick ?? drag.key);
      else if (drag.kind === "zone") {
        const z = graph.zones.find((x) => x.site === drag.key);
        if (z) setNode(drag.key, { x: Math.round(z.x + z.w / 2 + drag.dx), y: Math.round(z.y + z.h / 2 + drag.dy) });
      } else {
        const n = graph.byKey.get(drag.key)!;
        // Закрепляем центр прямоугольника узла (с подписью).
        const d = DIM[n.kind];
        setNode(drag.key, { x: Math.round(n.x + drag.dx), y: Math.round(n.y + drag.dy + (d.bottom - d.top) / 2) });
      }
      setDrag(null);
    }
    if (pan) {
      if (!pan.moved) {
        if (pan.pick) pick(pan.pick);
        else { setSel(null); if (side?.kind === "found") setSide(null); }
      }
      setPan(null);
    }
  };

  const search = () => {
    if (!graph || !query.trim()) return;
    const q = query.trim().toLowerCase();
    const n = graph.nodes.find((x) => x.label.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q) || x.ips.some((ip) => ip.includes(q)));
    if (n) { pick(n.key); centerOn(n.x, n.y); return; }
    const b = [...graph.beads.values()].find((x) => x.ip.includes(q) || x.label.toLowerCase().includes(q));
    if (b) { pick(b.key); centerOn(b.x, b.y); return; }
    const d = scan?.devices.find((x) => !x.targetId && (x.ip.includes(q) || (x.name ?? "").toLowerCase().includes(q) || (x.vendor ?? "").toLowerCase().includes(q)));
    if (d) { setSel(null); setSide({ kind: "found", subnet: d.subnet }); return; }
    toast(t("Узел не найден"), "error");
  };

  const startScan = async (subnets: string[]) => {
    try {
      await api.scanStart(subnets);
      setScanDlg(false);
      setProg(await api.scanProgress());
    } catch (e) { toast(String(e), "error"); }
  };

  if (!layout || !graph) return <div className="fm-empty">{t("Загружаю карту…")}</div>;

  const k = view.k;
  const focus = sel ?? hover?.key ?? null;
  const selNode = sel ? graph.byKey.get(sel) ?? null : null;
  const selBead = sel ? graph.beads.get(sel) ?? null : null;
  const selZone = sel?.startsWith("zone:") ? sel.slice(5) : null;
  const hovNode = hover ? graph.byKey.get(hover.key) ?? null : null;
  const hovBead = hover ? graph.beads.get(hover.key) ?? null : null;
  const hiddenHops = Object.values(layout.nodes).filter((c) => c.hidden).length;
  const excludedN = layout.excluded.groups.length + layout.excluded.targets.length + hiddenHops;
  const movedCount = Object.values(layout.nodes).filter((c) => c.x != null).length;
  const enabled = items.filter((i) => i.enabled);
  const problems = enabled.filter((i) => i.health === "down" || i.health === "crit" || i.health === "bad" || i.health === "warn").length;
  const foundN = [...graph.found.values()].reduce((a, b) => a + b, 0);
  const allGroups = [...new Set([...groups, ...items.map((i) => i.group)])].filter(Boolean).sort((a, b) => a.localeCompare(b, "ru"));
  const zoneByKey = new Map(graph.zones.map((z) => [z.key, z]));
  // Геометрия линий: по точкам раскладки; если конец сдвинут (вручную или сейчас тащат) —
  // плавной кривой напрямую.
  const dir = graph.dir;
  const rectAt = (key: string): { r: Rect; moved: boolean } | null => {
    const n = graph.byKey.get(key);
    if (n) { const p = pos(n); return { r: nodeRect({ kind: n.kind, ...p }), moved: n.pinned || p.x !== n.x || p.y !== n.y }; }
    const z = zoneByKey.get(key);
    if (!z) return null;
    const sh = zoneShift(z);
    return { r: { x: z.x + sh.dx, y: z.y + sh.dy, w: z.w, h: z.h }, moved: z.moved || sh.dx !== 0 || sh.dy !== 0 };
  };
  const geo = new Map<string, { line: P[]; pieces: P[][]; beads: P[] }>();
  for (const e of graph.edges) {
    if (e.kind === "link") continue;
    const ra = rectAt(e.a), rb = rectAt(e.b);
    if (!ra || !rb) continue;
    const a0 = outOf(ra.r, dir), b0 = inOf(rb.r, dir);
    const line = e.pts.length >= 3 && !ra.moved && !rb.moved ? smooth([a0, ...e.pts.slice(1, -1), b0], dir) : cubicPts(a0, b0, dir);
    geo.set(e.key, { line, ...splitAt(line, e.beads.length) });
  }
  const renderEdge = (e: GEdge) => {
    const hi = focus != null && (e.a === focus || e.b === focus || e.beads.some((b) => b.key === focus) || (!!selNode?.site && (e.a === selNode.site || e.b === selNode.site)));
    if (e.kind === "link") {
      const na = graph.byKey.get(e.a), nb = graph.byKey.get(e.b);
      if (!na || !nb) return null;
      if (!layout.opts.tunnels && !hi && e.st !== "down") return null;
      return <Link key={e.key} e={e} a={pos(na)} b={pos(nb)} k={k} hi={hi} />;
    }
    const g = geo.get(e.key);
    return g ? <Edge key={e.key} e={e} g={g} flow={layout.opts.flow} hi={hi} /> : null;
  };
  const reset = () => {
    update((l) => {
      for (const [key, c] of Object.entries(l.nodes)) {
        delete c.x; delete c.y;
        if (!Object.keys(c).length) delete l.nodes[key];
      }
      l.collapsed = [];
      return l;
    });
    fitted.current = false;
    setSel(null);
    setGear(false);
    toast(t("Схема собрана заново"));
  };
  const setOpt = <K extends keyof Layout["opts"]>(key: K, v: Layout["opts"][K]) => update((l) => ({ ...l, opts: { ...l.opts, [key]: v } }));
  const deviceFor = (ips: string[]) => ips.map((ip) => devByIp.get(ip)).find(Boolean) ?? null;

  return (
    <div className="fm">
      <div className="fm-bar">
        <div className="fm-search">
          <input className="input" placeholder={t("Найти: имя, IP, производитель…")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
        </div>
        <div className="fm-zoom">
          <button className="btn ghost sm" onClick={() => zoomAt(1 / 1.25)} title={t("Мельче")}>−</button>
          <span className="num">{Math.round(k * 100)}%</span>
          <button className="btn ghost sm" onClick={() => zoomAt(1.25)} title={t("Крупнее")}>+</button>
          <button className="btn ghost sm" onClick={fit}>{t("Вписать")}</button>
        </div>
        <span style={{ flex: 1 }} />
        {running ? (
          <div className="fm-scan-prog" title={prog!.phase}>
            <span className="fm-scan-ph">{t(prog!.phase || "Сканирую")}</span>
            <span className="fm-scan-bar"><i style={{ width: `${prog!.total ? Math.round((prog!.done / prog!.total) * 100) : 0}%` }} /></span>
            <span className="num c-muted">{prog!.done}/{prog!.total}</span>
            <button className="btn ghost sm" onClick={() => api.scanStop().catch(() => {})}>{t("Остановить")}</button>
          </div>
        ) : (
          <button className="btn sm" onClick={() => setScanDlg(true)} title={t("Пройти маршрутами до всех целей и найти устройства в подсетях. Карта строится по результату")}>
            {t("Сканировать сеть")}
          </button>
        )}
        {foundN > 0 && (
          <button className={"btn sm" + (side?.kind === "found" ? "" : " ghost")} onClick={() => { setSel(null); setSide(side?.kind === "found" ? null : { kind: "found", subnet: null }); }}
            title={t("Устройства, найденные сканом, которых нет в мониторинге")}>
            {t("Найдено")}: {foundN}
          </button>
        )}
        <button className={"btn sm" + (edit ? "" : " ghost")} onClick={() => setEdit((v) => !v)} title={t("Перетаскивать узлы, менять подписи, типы, склеивать адреса")}>
          {edit ? t("Готово") : t("Правка")}
        </button>
        <div className="fm-gear-wrap">
          <button className={"btn ghost sm" + (gear ? " on" : "")} onClick={() => setGear((v) => !v)} title={t("Вид карты")}>⚙</button>
          {gear && (
            <div className="fm-gear" onMouseLeave={() => setGear(false)}>
              <label className="check"><input type="checkbox" checked={layout.opts.flow} onChange={(e) => setOpt("flow", e.target.checked)} /><span className="sw" /><span>{t("Бегущие точки по линиям")}</span></label>
              <label className="check"><input type="checkbox" checked={layout.opts.hopLabels} onChange={(e) => setOpt("hopLabels", e.target.checked)} /><span className="sw" /><span>{t("Подписи всех хопов")}</span></label>
              <label className="check"><input type="checkbox" checked={layout.opts.tunnels} onChange={(e) => setOpt("tunnels", e.target.checked)} /><span className="sw" /><span>{t("Все туннели дугами")}</span></label>
              <div className="fm-gear-row">
                <span>{t("Направление")}</span>
                <select className="input" value={layout.opts.dir} onChange={(e) => setOpt("dir", e.target.value as Dir)}>
                  <option value="TB">{t("Сверху вниз")}</option>
                  <option value="BT">{t("Снизу вверх")}</option>
                  <option value="LR">{t("Слева направо")}</option>
                </select>
              </div>
              <div className="fm-gear-sep" />
              <button className="btn ghost sm" onClick={() => { setGear(false); setSel(null); setSide({ kind: "hidden" }); }}>{t("Скрыто с карты")}{excludedN ? `: ${excludedN}` : ""}</button>
              {movedCount > 0 && <button className="btn ghost sm" onClick={reset} title={t("Убрать ручные положения и свёрнутые группы; подписи и иконки остаются")}>{t("Собрать заново")}</button>}
            </div>
          )}
        </div>
      </div>

      <div className="fm-body">
        <div
          ref={wrap}
          className={"fm-canvas" + (pan?.moved ? " panning" : "") + (drag?.moved ? " dragging" : "") + (edit ? " editing" : "")}
          onMouseDown={(e) => { if (e.button === 0) setPan({ x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false }); }}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={() => { onUp(); setHover(null); }}
        >
          <svg width={size.w} height={size.h} className={layout.opts.flow ? "flow" : ""}>
            <defs>
              {(Object.keys(ST_COLOR) as St[]).map((s) => (
                <radialGradient key={s} id={"glow-" + s}>
                  <stop offset="0%" stopColor={ST_COLOR[s]} stopOpacity={s === "idle" ? 0.2 : 0.5} />
                  <stop offset="50%" stopColor={ST_COLOR[s]} stopOpacity={s === "idle" ? 0.06 : 0.16} />
                  <stop offset="100%" stopColor={ST_COLOR[s]} stopOpacity={0} />
                </radialGradient>
              ))}
              <pattern id="fm-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill={cv("--map-grid")} />
              </pattern>
            </defs>
            <rect width={size.w} height={size.h} fill="url(#fm-grid)" />
            <g transform={`translate(${view.tx},${view.ty}) scale(${k})`}>
              {graph.zones.map((z) => <ZoneBg key={z.key} z={z} shift={zoneShift(z)} selected={selZone === z.site} />)}
              {graph.edges.map((e) => renderEdge(e))}
              {graph.edges.map((e) => {
                const g = geo.get(e.key);
                if (!g || !e.beads.length || g.beads.length !== e.beads.length) return null;
                return e.beads.map((bd, i) => (
                  <BeadDot key={e.key + bd.key} b={bd} x={g.beads[i].x} y={g.beads[i].y} k={k}
                    selected={sel === bd.key}
                    label={layout.opts.hopLabels || k >= 0.9 || bd.st === "down" || bd.st === "warn" || sel === bd.key || hover?.key === bd.key || !!layout.nodes[bd.key]?.label}
                    onClick={(ev) => { ev.stopPropagation(); pick(bd.key); }}
                    onHover={(on, ev) => setHover(on && ev ? { key: bd.key, x: ev.clientX, y: ev.clientY } : null)} />
                ));
              })}
              {graph.zones.map((z) => <ZoneTitle key={z.key} z={z} shift={zoneShift(z)} k={k} edit={edit} onDown={(e) => startDrag("zone", z.site, e)} />)}
              {graph.nodes.map((n) => (
                <Node key={n.key} n={n} p={pos(n)} k={k} selected={sel === n.key || (n.kind === "zone" && !!n.site && selZone === n.site) || (side?.kind === "found" && n.key === "found:" + side.subnet)}
                  onDown={(e) => (n.kind === "target" && n.site ? startDrag("zone", n.site, e, n.key) : startDrag("node", n.key, e))}
                  onDouble={() => n.target && onOpen(n.target.id)}
                  onHover={(on, ev) => setHover(on && ev ? { key: n.key, x: ev.clientX, y: ev.clientY } : null)} />
              ))}
            </g>
          </svg>

          <div className="fm-legend">
            <span><i style={{ background: ST_COLOR.ok }} />{t("отвечает")}</span>
            <span><i style={{ background: ST_COLOR.warn }} />{t("часть маршрутов рвётся")}</span>
            <span><i style={{ background: ST_COLOR.down }} />{t("обрыв")}</span>
            <span><i style={{ background: ST_COLOR.dep }} />{t("недоступно из-за узла выше")}</span>
            <span><i style={{ background: ST_COLOR.idle }} />{t("нет данных")}</span>
            <span className="c-muted">· {edit ? t("режим правки: узлы и рамки можно перетаскивать") : t("точки на линиях — промежуточные хопы")}</span>
          </div>
          <div className="fm-stat">
            {plural(enabled.length, "цель", "цели", "целей")}
            {problems > 0 && <> · <b className="c-warn">{plural(problems, "проблема", "проблемы", "проблем")}</b></>}
            {" · "}
            {scan ? <>{t("скан")} {fmtDateTime(scan.finished)}</> : <span className="c-warn">{t("скан ещё не выполнялся — карта по фоновой трассировке")}</span>}
            {!scan && (topo?.pending ?? 0) > 0 && <> · {t("маршрут определяется")}: {topo!.pending}</>}
          </div>

          {hovNode && hovNode.kind !== "zone" && !drag?.moved && !pan?.moved && <Tip n={hovNode} dev={deviceFor(hovNode.ips)} x={hover!.x} y={hover!.y} box={wrap.current!.getBoundingClientRect()} />}
          {hovBead && !drag?.moved && !pan?.moved && <BeadTip b={hovBead} dev={deviceFor(hovBead.ip.split(", "))} x={hover!.x} y={hover!.y} box={wrap.current!.getBoundingClientRect()} />}
        </div>

        {((selNode && selNode.kind !== "zone") || selBead) && (
          <Inspector
            n={selNode}
            bead={selBead}
            graph={graph}
            dev={deviceFor(selNode?.ips ?? selBead!.ip.split(", "))}
            edit={edit}
            layout={layout}
            onEdit={() => setEdit(true)}
            onClose={() => setSel(null)}
            onOpen={onOpen}
            setNode={setNode}
            update={update}
            groupKeys={selNode?.target ? items.filter((i) => i.group === selNode.target!.group).map((i) => "t:" + i.id) : []}
            groups={allGroups}
            items={items}
            toast={toast}
            onZone={(id) => setSel("zone:" + id)}
          />
        )}
        {(selZone || (selNode?.kind === "zone" && selNode.site)) && (() => {
          const id = selZone ?? selNode!.site!;
          const z = zoneByKey.get(id) ?? null;
          const card = graph.byKey.get(ZONE(id)) ?? null;
          const group = z?.group ?? card?.label ?? "";
          const members = (z?.members ?? []).map((m) => graph.byKey.get(m)).filter((m): m is GNode => !!m);
          return <ZonePanel id={id} group={group} zone={z} card={card} layout={layout} edit={edit} members={members}
            onPick={(key) => setSel(key)} onClose={() => setSel(null)} update={update} toast={toast} />;
        })()}
        {side?.kind === "found" && !selNode?.target && !selBead && !selZone && (
          <FoundPanel scan={scan} items={items} groups={allGroups} subnet={side.subnet}
            onSubnet={(s) => setSide({ kind: "found", subnet: s })}
            onClose={() => { setSide(null); setSel(null); }} toast={toast} />
        )}
        {side?.kind === "hidden" && !sel && (
          <HiddenPanel layout={layout} groups={allGroups} items={items} onClose={() => setSide(null)} update={update} />
        )}
      </div>
      {scanDlg && <ScanDialog scan={scan} onClose={() => setScanDlg(false)} onStart={startScan} />}
    </div>
  );
}

/** Фон зоны. Любая зона непрозрачна: линии к нижним зонам уходят под верхние. */
function ZoneBg({ z, shift, selected }: { z: Zone; shift: { dx: number; dy: number }; selected: boolean }) {
  const c = ST_COLOR[z.st];
  const site = true as boolean;
  const x = z.x + shift.dx, y = z.y + shift.dy;
  return (
    <g className={"fm-zone " + z.kind + (selected ? " sel" : "")}>
      <rect x={x} y={y} width={z.w} height={z.h} rx={site ? 20 : 14}
        fill={c} fillOpacity={z.st === "ok" ? 0.04 : 0.09}
        stroke={c} strokeOpacity={selected ? 0.95 : z.st === "ok" ? 0.35 : 0.7} strokeWidth={selected ? 2 : 1.3} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/** Заголовок зоны: название и счётчик; за него площадку можно перетащить.
 *  Вблизи — внутри рамки. На обзоре заголовок площадки держит экранный размер и
 *  выносится плашкой над рамкой, чтобы не налезать на вложенные группы; мелкие заголовки
 *  групп и кустов на обзоре не показываются. */
function ZoneTitle({ z, shift, k, edit, onDown }: { z: Zone; shift: { dx: number; dy: number }; k: number; edit: boolean; onDown: (e: React.MouseEvent) => void }) {
  const c = ST_COLOR[z.st];
  const site = true as boolean;
  const x = z.x + shift.dx, y = z.y + shift.dy;
  const okN = z.total - z.bad;
  const counter = `${z.bad ? `${z.bad} ${t("проблем")} · ` : ""}${okN}/${z.total}`;
  const base = site ? 17 : z.kind === "group" ? 13 : 12;
  const screen = site ? 14 : 11;
  const far = base * k < screen;
  if (far && !site && k < 0.4) return null;
  if (far && site) {
    // Плашка не шире своей площадки: сначала убираем счётчик, потом уменьшаем шрифт.
    const room = z.w + 8;
    const width = (chars: number, f: number) => chars * f * 0.6 + f * 1.4;
    let fs = screen / k;
    const withN = width(z.title.length + counter.length + 2, fs) <= room;
    const chars = withN ? z.title.length + counter.length + 2 : z.title.length;
    if (width(chars, fs) > room) fs = Math.max(base, room / (chars * 0.6 + 1.4));
    const tw = width(chars, fs);
    const h = fs * 1.6;
    return (
      <g className="fm-zone-title" onMouseDown={onDown} style={{ cursor: edit ? "move" : "pointer" }}>
        <rect x={x} y={y - h - 2 / k} width={tw} height={h} rx={h / 2} fill={cv("--map-chip")} fillOpacity={0.92} stroke={c} strokeOpacity={z.bad ? 0.8 : 0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <text x={x + fs * 0.7} y={y - 2 / k - h * 0.3} className={"fm-zone-t " + z.kind} fontSize={fs} style={{ strokeWidth: 0 }}>
          {z.title}
          {withN && <tspan dx={fs * 0.6} className="fm-zone-n" fill={z.bad ? c : undefined}>{counter}</tspan>}
        </text>
      </g>
    );
  }
  const fs = far ? Math.min(base * 1.3, screen / k) : base;
  return (
    <g className="fm-zone-title" onMouseDown={onDown} style={{ cursor: edit ? "move" : "pointer" }}>
      <rect x={x} y={y} width={z.w} height={site ? 34 : 26} fill="transparent" />
      <text x={x + (site ? 18 : 14)} y={y + (site ? 6 : 4) + fs} className={"fm-zone-t " + z.kind} fontSize={fs}>
        {z.title}
        <tspan dx={10} className="fm-zone-n" fill={z.bad ? c : undefined}>{counter}</tspan>
      </text>
    </g>
  );
}

/** Туннель (GRE и т. п.) между двумя узлами — дуга в цвет состояния с подписью. */
function Link({ e, a, b, k, hi }: { e: GEdge; a: { x: number; y: number }; b: { x: number; y: number }; k: number; hi: boolean }) {
  const c = ST_COLOR[e.st];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Дуга выгибается в сторону, чтобы не лечь на линии дерева.
  const bend = Math.min(160, len * 0.18);
  const mx = (a.x + b.x) / 2 - (dy / len) * bend, my = (a.y + b.y) / 2 + (dx / len) * bend;
  const d = `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
  const broken = e.st === "down";
  const lx = (a.x + 2 * mx + b.x) / 4, ly = (a.y + 2 * my + b.y) / 4;
  const names = e.names ?? [];
  const kw = names[0]?.match(/gre|ipsec|l2tp|vxlan|tunnel|туннель/i)?.[0].toUpperCase() ?? "GRE";
  const label = names.length > 1 ? `${kw} ×${names.length}` : kw;
  const fs = 11 / Math.max(k, 0.35);
  return (
    <g className="fm-link">
      <title>{names.join("\n")}</title>
      <path d={d} stroke={c} strokeOpacity={hi ? 0.35 : 0.12} strokeWidth={hi ? 8 : 6} fill="none" vectorEffect="non-scaling-stroke" />
      <path d={d} stroke={c} strokeOpacity={broken ? 0.95 : hi ? 0.95 : 0.45} strokeWidth={broken || hi ? 2.2 : 1.4} fill="none" vectorEffect="non-scaling-stroke"
        strokeDasharray={broken ? "6 5" : undefined} className={broken ? "fm-broken" : undefined} />
      {(hi || broken || k > 0.6) && (
        <g transform={`translate(${lx},${ly})`}>
          <rect x={-fs * 2.2} y={-fs * 0.85} width={fs * 4.4} height={fs * 1.7} rx={fs * 0.85} fill={cv("--map-chip")} stroke={c} strokeOpacity={0.7} vectorEffect="non-scaling-stroke" />
          <text textAnchor="middle" y={fs * 0.35} fontSize={fs} fill={c} style={{ fontWeight: 600 }}>{label}</text>
        </g>
      )}
    </g>
  );
}

/** Линия: гладкая кривая; каждый отрезок между хопами — в цвет того, доходят ли до него пакеты.
 *  Толщина — сколько маршрутов по ней идёт (пучок сливается в одну линию). */
function Edge({ e, g, flow, hi }: { e: GEdge; g: { line: P[]; pieces: P[][] }; flow: boolean; hi: boolean }) {
  const d = (pts: P[]) => "M" + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L");
  const full = d(g.line);
  const w = 1.4 + Math.min(2.2, Math.log2(Math.max(1, e.pass)) * 0.45);
  const allBroken = e.segs.every((s) => s === "down" || s === "dep");
  return (
    <g className="fm-edge">
      <path d={full} stroke={ST_COLOR[e.st]} strokeOpacity={hi ? 0.3 : 0.1} strokeWidth={(hi ? 8 : 5) + w} fill="none" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      {g.pieces.map((pc, i) => {
        const s = e.segs[i] ?? e.st;
        const broken = s === "down";
        const gray = s === "dep";
        return (
          <path key={i} d={d(pc)} stroke={ST_COLOR[s]} strokeOpacity={broken ? 0.95 : gray ? 0.7 : s === "idle" ? 0.45 : hi ? 0.95 : 0.65}
            strokeWidth={broken ? w + 0.8 : hi ? w + 0.6 : w} fill="none" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray={broken ? "6 5" : gray ? "3 6" : e.kind === "pending" ? "3 5" : undefined} className={broken ? "fm-broken" : undefined} />
        );
      })}
      {flow && !allBroken && e.st !== "idle" && e.kind === "route" && (
        <path d={full} stroke={ST_COLOR[e.st]} strokeWidth={w + 1} fill="none" vectorEffect="non-scaling-stroke" className="fm-flow" strokeLinecap="round" />
      )}
    </g>
  );
}

function BeadDot({ b, x, y, k, selected, label, onClick, onHover }: {
  b: Bead; x: number; y: number; k: number; selected: boolean; label: boolean;
  onClick: (e: React.MouseEvent) => void; onHover: (on: boolean, e?: React.MouseEvent) => void;
}) {
  const c = ST_COLOR[b.st];
  const r = Math.max(3.2, 4.2 / Math.sqrt(Math.max(k, 0.3)));
  const problem = b.st === "down" || b.st === "warn";
  return (
    <g transform={`translate(${x},${y})`} className="fm-bead" style={{ color: c }}
      onMouseDown={(e) => e.stopPropagation()} onClick={onClick}
      onMouseEnter={(e) => onHover(true, e)} onMouseMove={(e) => onHover(true, e)} onMouseLeave={() => onHover(false)}>
      <circle r={r * 3} fill={`url(#glow-${b.st})`} className={problem ? "fm-pulse" : undefined} />
      <circle r={r * 2.4} fill="transparent" />
      <circle r={r} fill={c} stroke={cv("--map-halo")} strokeWidth={1.2} />
      {selected && <circle r={r * 2.2} fill="none" stroke={c} strokeWidth={1.3} strokeDasharray="3 3" />}
      {label && <text x={r + 6} y={4} className="fm-hop-label" fill={problem ? c : undefined}>{b.label}</text>}
    </g>
  );
}

function Node({ n, p, k, selected, onDown, onDouble, onHover }: {
  n: GNode;
  p: { x: number; y: number };
  k: number;
  selected: boolean;
  onDown: (e: React.MouseEvent) => void;
  onDouble: () => void;
  onHover: (on: boolean, e?: React.MouseEvent) => void;
}) {
  const c = ST_COLOR[n.st];
  const problem = n.st === "down" || n.st === "bad" || n.st === "warn";
  const cut = (v: string, m: number) => (v.length > m ? v.slice(0, m - 1) + "…" : v);
  const common = {
    transform: `translate(${p.x},${p.y})`,
    onMouseDown: onDown,
    onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); onDouble(); },
    onMouseEnter: (e: React.MouseEvent) => onHover(true, e),
    onMouseMove: (e: React.MouseEvent) => onHover(true, e),
    onMouseLeave: () => onHover(false),
    className: "fm-node " + n.kind + " " + n.st + (selected ? " sel" : ""),
    style: { color: c },
  };

  // Найденные сканом устройства, которых нет в мониторинге, — карточка на подсеть.
  if (n.kind === "zone" && n.key.startsWith("found:")) {
    return (
      <g {...common} className={common.className + " found"}>
        <rect x={-112} y={-40} width={224} height={80} rx={16} className="fm-tile" stroke={ST_COLOR.info} strokeDasharray="5 4" strokeWidth={selected ? 2.2 : 1.4} />
        <NodeGlyph type="device" variant={0} size={28} x={-80} y={-4} />
        <text x={-52} y={-10} className="fm-card-t" style={{ fontSize: 14 }}>{plural(n.total ?? 0, "устройство", "устройства", "устройств")}</text>
        <text x={-52} y={8} className="fm-sub">{t("не в мониторинге")}</text>
        <text x={-52} y={24} className="fm-sub">{n.subnet}</text>
      </g>
    );
  }

  // Свёрнутая группа — карточка с итогом.
  if (n.kind === "zone") {
    return (
      <g {...common}>
        <circle r={110} fill={`url(#glow-${n.st})`} opacity={0.6} />
        <rect x={-112} y={-44} width={224} height={88} rx={16} className="fm-tile" stroke={c} strokeWidth={selected ? 2.4 : 1.6} />
        <NodeGlyph type="building" variant={1} size={30} x={-80} y={-6} />
        <text x={-52} y={-10} className="fm-card-t">{cut(n.label, 18)}</text>
        <text x={-52} y={10} className="fm-sub">{plural(n.total ?? 0, "цель", "цели", "целей")}</text>
        {!!n.bad && <text x={-52} y={27} className="fm-why" fill={c}>{plural(n.bad, "проблема", "проблемы", "проблем")}</text>}
      </g>
    );
  }

  // Развилка маршрутов: небольшой круглый узел; если хопу дали тип — его иконка.
  if (n.kind === "hop") {
    const s = 34;
    return (
      <g {...common}>
        <circle r={30} fill={`url(#glow-${n.st})`} className={problem ? "fm-pulse" : undefined} />
        <circle r={s / 2} className="fm-tile" stroke={c} />
        <NodeGlyph type={n.type === "hop" ? "router" : n.type} variant={n.type === "hop" ? 2 : n.variant} size={20} />
        {selected && <circle r={s / 2 + 6} fill="none" stroke={c} strokeWidth={1.4} strokeDasharray="4 3" />}
        {k > 0.35 && <text y={s / 2 + 15} textAnchor="middle" className="fm-hub-label">{cut(n.label, 24)}</text>}
        {k > 0.6 && n.sub && <text y={s / 2 + 28} textAnchor="middle" className="fm-sub">{cut(n.sub, 30)}</text>}
      </g>
    );
  }

  const s = n.kind === "local" ? 58 : n.kind === "net" ? 50 : 46;
  const why = n.target ? problemText(n.target) : "";
  const lod = k < 0.32 ? 0 : k < 0.6 ? 1 : 2;
  // У этого компьютера подпись справа, у остальных — под иконкой.
  const right = n.kind === "local";
  const lx = right ? s / 2 + 12 : 0, ly = right ? -2 : s / 2 + 16;
  const anchor = right ? "start" : "middle";
  return (
    <g {...common}>
      <circle r={s * 1.05} fill={`url(#glow-${n.st})`} className={problem ? "fm-pulse" : undefined} />
      <rect x={-s / 2} y={-s / 2} width={s} height={s} rx={s * 0.28} className="fm-tile" stroke={c} />
      <NodeGlyph type={n.type} variant={n.variant} size={s * 0.6} />
      {selected && <rect x={-s / 2 - 5} y={-s / 2 - 5} width={s + 10} height={s + 10} rx={s * 0.28 + 4} fill="none" stroke={c} strokeWidth={1.4} strokeDasharray="4 3" />}
      {(lod > 0 || problem || right || n.kind === "net") && <text x={lx} y={ly} textAnchor={anchor} className={right ? "fm-local-label" : "fm-label"}>{cut(n.label, right ? 30 : 19)}</text>}
      {(lod > 1 || right) && n.sub && <text x={lx} y={ly + (right ? 18 : 14)} textAnchor={anchor} className="fm-sub">{cut(n.sub, n.kind === "net" ? 28 : 22)}</text>}
      {lod > 0 && problem && why && <text x={lx} y={ly + (lod > 1 && n.sub ? 28 : 14)} textAnchor={anchor} className="fm-why" fill={c}>{cut(why, 24)}</text>}
    </g>
  );
}

/** Коротко об устройстве по скану: тип, система, производитель. */
const devLine = (d: ScanDevice) => [d.kind && d.kind !== "device" ? t(DEVICE_KIND[d.kind] ?? d.kind) : "", d.os ?? "", d.vendor ?? ""].filter(Boolean).join(" · ");

function Tip({ n, dev, x, y, box }: { n: GNode; dev: ScanDevice | null; x: number; y: number; box: DOMRect }) {
  const left = Math.min(x - box.left + 16, box.width - 290);
  const top = Math.min(y - box.top + 14, box.height - 170);
  const s = n.target;
  return (
    <div className="fm-tip" style={{ left, top }}>
      <div className="fm-tip-h" style={{ color: ST_COLOR[n.st] }}>{n.label}</div>
      {n.sub && <div className="c-muted num">{n.sub}</div>}
      {s && <div>{KIND_LABEL[s.kind]} · {s.group}</div>}
      {dev && devLine(dev) && <div className="c-muted">{devLine(dev)}</div>}
      {s && problemText(s) && <div style={{ color: ST_COLOR[n.st] }}>{problemText(s)}</div>}
      {s && s.health !== "down" && s.health !== "dependent" && (
        <div className="c-muted">{t("задержка")} <b className="num c-text">{fmtMs(s.avgRtt)} {t("мс")}</b> · {t("потери")} <b className="num c-text">{fmtPct(s.lossPct)}%</b></div>
      )}
      {(n.kind === "hop" || n.kind === "net") && (
        <div className="c-muted">
          {n.kind === "hop" ? t("развилка") + " · " : ""}{t("через узел идут")} {plural(n.pass, "маршрут", "маршрута", "маршрутов")}
          {n.lost > 0 && <span style={{ color: ST_COLOR[n.lost === n.pass ? "down" : "warn"] }}> · {t("обрываются")}: {n.lost}</span>}
        </div>
      )}
    </div>
  );
}

function BeadTip({ b, dev, x, y, box }: { b: Bead; dev: ScanDevice | null; x: number; y: number; box: DOMRect }) {
  const left = Math.min(x - box.left + 16, box.width - 290);
  const top = Math.min(y - box.top + 14, box.height - 140);
  return (
    <div className="fm-tip" style={{ left, top }}>
      <div className="fm-tip-h num" style={{ color: ST_COLOR[b.st] }}>{b.label}</div>
      {b.label !== b.ip && <div className="c-muted num">{b.ip}</div>}
      {dev && devLine(dev) && <div className="c-muted">{devLine(dev)}</div>}
      <div className="c-muted">
        {t("промежуточный хоп")}
        {b.hop?.rtt != null && <> · {t("задержка")} <b className="num c-text">{fmtMs(b.hop.rtt, 1)} {t("мс")}</b></>}
        {b.hop?.loss != null && <> · {t("потери")} <b className="num c-text">{fmtPct(b.hop.loss)}%</b></>}
      </div>
      {b.lost > 0 && <div style={{ color: ST_COLOR[b.lost === b.pass ? "down" : "warn"] }}>{b.lost === b.pass ? t("пакеты сюда не доходят") : `${t("обрываются")} ${b.lost} ${t("из")} ${b.pass}`}</div>}
    </div>
  );
}

/** Что скан узнал об устройстве. */
function DeviceInfo({ d }: { d: ScanDevice }) {
  const rows: [string, string][] = [];
  if (d.kind) rows.push([t("Тип"), t(DEVICE_KIND[d.kind] ?? d.kind)]);
  if (d.os) rows.push([t("Система"), d.os + (d.osSource ? ` (${t("по")} ${d.osSource})` : "")]);
  if (d.vendor) rows.push([t("Производитель"), d.vendor]);
  if (d.mac) rows.push(["MAC", d.mac]);
  if (d.name) rows.push([t("Имя в DNS"), d.name]);
  if (d.rtt != null) rows.push([t("Отклик"), `${fmtMs(d.rtt, 1)} ${t("мс")}`]);
  return (
    <div className="fm-dev">
      {rows.map(([a, b]) => <div key={a} className="fm-dev-row"><span>{a}</span><b>{b}</b></div>)}
      {d.services.length > 0 && (
        <div className="fm-dev-svc">
          {d.services.map((s) => (
            <div key={s.port} title={s.banner ?? ""}>
              <span className="num">{s.port}</span> {s.name}{s.banner ? <span className="c-muted"> — {s.banner.length > 60 ? s.banner.slice(0, 59) + "…" : s.banner}</span> : null}
            </div>
          ))}
        </div>
      )}
      {!d.services.length && d.ports.length > 0 && <div className="c-muted num" style={{ marginTop: 6 }}>{t("Порты")}: {d.ports.join(", ")}</div>}
    </div>
  );
}

function Inspector({ n, bead, graph, dev, edit, layout, onEdit, onClose, onOpen, setNode, update, groupKeys, groups, items, toast, onZone }: {
  n: GNode | null;
  bead: Bead | null;
  graph: Graph;
  dev: ScanDevice | null;
  edit: boolean;
  layout: Layout;
  onEdit: () => void;
  onClose: () => void;
  onOpen: (id: string) => void;
  setNode: (key: string, patch: Partial<NodeCfg>) => void;
  update: (fn: (l: Layout) => Layout) => void;
  groupKeys: string[];
  groups: string[];
  items: TargetSummary[];
  toast: (msg: string, kind?: "ok" | "error") => void;
  onZone: (id: string) => void;
}) {
  const key = n?.key ?? bead!.key;
  const cfg = layout.nodes[key] ?? {};
  const s = n?.target;
  const st: St = n?.st ?? bead!.st;
  const type: NodeType = n?.type ?? cfg.type ?? "hop";
  const variant = n?.variant ?? cfg.variant ?? 0;
  const isHop = !n || n.kind === "hop";
  const label = n?.label ?? bead!.label;
  const typeLabel = NODE_TYPES.find((x) => x.k === type)?.l ?? "";
  const kindLabel = n?.kind === "local" ? t("Этот компьютер") : n?.kind === "net" ? t("Весь внешний интернет") : isHop ? (n ? t("Развилка маршрутов") : t("Промежуточный хоп")) : KIND_LABEL[s!.kind];
  const pass = n?.pass ?? bead!.pass, lost = n?.lost ?? bead!.lost;
  const hop = n?.hop ?? bead?.hop;
  const ips = n?.ips.length ? n.ips : bead ? bead.ip.split(", ") : [];
  return (
    <aside className="fm-panel">
      <div className="fm-panel-h">
        <div className="fm-panel-ico" style={{ color: ST_COLOR[st], borderColor: ST_COLOR[st] }}>
          {!n && type === "hop" ? <span className="fm-dot" style={{ background: ST_COLOR[st] }} /> : <NodeIcon type={type === "hop" ? "router" : type} variant={type === "hop" ? 2 : variant} size={26} />}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="fm-panel-t">{label}</div>
          <div className="c-muted" style={{ fontSize: 12 }}>{kindLabel}{s ? ` · ${s.group}` : ""}</div>
        </div>
        <button className="btn ghost sm" onClick={onClose}>✕</button>
      </div>

      <div className="fm-panel-sec">
        {(n?.sub || bead) && <div className="num c-muted" style={{ userSelect: "text" }}>{n?.sub || bead!.ip}</div>}
        {s && problemText(s) && <div style={{ color: ST_COLOR[st], marginTop: 6 }}>{problemText(s)}</div>}
        {s && s.health !== "down" && s.health !== "dependent" && (
          <div className="fm-kv">
            <div>{t("сейчас")}<b className="num">{s.lastRtt == null ? "✕" : fmtMs(s.lastRtt, 1)}</b></div>
            <div>{t("средняя")}<b className="num">{fmtMs(s.avgRtt)}</b></div>
            <div>{t("потери")}<b className="num">{fmtPct(s.lossPct)}%</b></div>
          </div>
        )}
        {(isHop || n?.kind === "net") && (
          <div className="fm-kv">
            {isHop && <div>{t("задержка")}<b className="num">{hop?.rtt == null ? "—" : fmtMs(hop.rtt, 1)}</b></div>}
            {isHop && <div>{t("потери")}<b className="num">{hop?.loss == null ? "—" : fmtPct(hop.loss) + "%"}</b></div>}
            <div>{t("маршрутов")}<b className="num">{pass}</b></div>
          </div>
        )}
        {(isHop || n?.kind === "net") && lost > 0 && (
          <div style={{ color: ST_COLOR[lost === pass ? "down" : "warn"], marginTop: 8 }}>
            {lost === pass ? t("Все маршруты через этот узел сейчас обрываются") : `${t("Обрываются")} ${lost} ${t("из")} ${pass} ${t("маршрутов через этот узел")}`}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          {s && <button className="btn sm" onClick={() => onOpen(s.id)}>{t("Открыть подробности")}</button>}
          {!edit && n?.kind !== "local" && <button className="btn ghost sm" onClick={onEdit}>{t("Изменить")}</button>}
        </div>
      </div>

      {s && <MapOperator id={s.id} />}

      {dev && (
        <div className="fm-panel-sec">
          <div className="fm-panel-lbl">{t("По данным скана")}</div>
          <DeviceInfo d={dev} />
        </div>
      )}

      {edit && n?.kind !== "local" && (
        <div className="fm-panel-sec">
          <div className="fm-panel-lbl">{t("Подпись на карте")}</div>
          <input className="input" value={cfg.label ?? ""} placeholder={isHop ? t("например, шлюз провайдера") : n?.kind === "net" ? t("Интернет") : s?.name} onChange={(e) => setNode(key, { label: e.target.value })} />
        </div>
      )}

      {edit && n?.kind !== "local" && n?.kind !== "net" && (
        <div className="fm-panel-sec">
          <div className="fm-panel-lbl">{t("Тип узла")}</div>
          <select className="input" value={type} onChange={(e) => setNode(key, { type: e.target.value as NodeType, variant: layout.variants[e.target.value as NodeType] ?? 0 })}>
            {NODE_TYPES.map((x) => <option key={x.k} value={x.k}>{t(x.l)}</option>)}
          </select>
          {isHop && type === "hop" && <div className="c-muted" style={{ fontSize: 11.5, marginTop: 6 }}>{t("Выберите тип — и хоп станет отдельным узлом на карте.")}</div>}
          {type !== "hop" && (
            <>
              <div className="fm-panel-lbl" style={{ marginTop: 12 }}>{t("Иконка")}</div>
              <div className="fm-variants">
                {[0, 1, 2].map((v) => (
                  <button key={v} className={variant === v ? "on" : ""} onClick={() => setNode(key, { variant: v })} title={`${t(typeLabel)} · ${v + 1}`}>
                    <NodeIcon type={type} variant={v} size={26} />
                  </button>
                ))}
              </div>
            </>
          )}
          {s && (
            <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => update((l) => {
              l.groups[s.group] = { type, variant };
              for (const gk of groupKeys) {
                const c = l.nodes[gk];
                if (!c) continue;
                delete c.type; delete c.variant;
                if (!Object.keys(c).length) delete l.nodes[gk];
              }
              return l;
            })}>
              {t("Применить ко всей группе")} «{s.group}»
            </button>
          )}
          {type !== "hop" && (
            <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => update((l) => { l.variants[type] = variant; return l; })}>
              {t("Эту иконку — всем узлам типа")} «{t(typeLabel)}»
            </button>
          )}
        </div>
      )}

      {edit && n?.kind !== "local" && n?.kind !== "net" && ips.length > 0 && (
        <MergeEdit self={key} ips={ips} isTarget={!!s} graph={graph} layout={layout} update={update} />
      )}

      {edit && s && <TargetEdit s={s} n={n!} groups={groups} items={items} update={update} toast={toast} onZone={onZone} />}

      {edit && (n?.pinned || isHop) && (
        <div className="fm-panel-sec fm-panel-actions">
          {n?.pinned && <button className="btn ghost sm" onClick={() => setNode(key, { x: undefined, y: undefined })}>{t("Вернуть на место")}</button>}
          {isHop && <button className="btn ghost sm" title={t("Хоп пропадёт с линий; вернуть — ⚙ → «Скрыто с карты»")} onClick={() => { setNode(key, { hidden: true }); onClose(); }}>{t("Скрыть хоп")}</button>}
        </div>
      )}
    </aside>
  );
}

/** Склейка адресов: маршрутизатор отвечает в трассировке адресом своего интерфейса,
 *  и на карте получаются два узла вместо одного. Здесь это исправляется вручную. */
function MergeEdit({ self, ips, isTarget, graph, layout, update }: {
  self: string;
  ips: string[];
  isTarget: boolean;
  graph: Graph;
  layout: Layout;
  update: (fn: (l: Layout) => Layout) => void;
}) {
  const [q, setQ] = useState("");
  const mine = new Set(ips);
  const linked = Object.entries(layout.aliases).filter(([a, b]) => mine.has(a) || mine.has(b));
  type Cand = { key: string; label: string; ips: string[]; target: boolean };
  const cands: Cand[] = [];
  for (const n of graph.nodes) {
    if (n.key === self || !n.ips.length) continue;
    if (n.kind === "target" && !isTarget) cands.push({ key: n.key, label: n.label, ips: n.ips, target: true });
    if (n.kind === "hop") cands.push({ key: n.key, label: n.label, ips: n.ips, target: false });
  }
  for (const b of graph.beads.values()) if (b.key !== self) cands.push({ key: b.key, label: b.label, ips: b.ip.split(", "), target: false });
  const qq = q.trim().toLowerCase();
  const shown = qq ? cands.filter((c) => c.label.toLowerCase().includes(qq) || c.ips.some((ip) => ip.includes(qq))).slice(0, 8) : [];
  const merge = (c: Cand) => update((l) => {
    // Хоп склеивается с целью или с другим хопом: все его адреса указывают на адрес того узла.
    if (isTarget) for (const ip of c.ips) l.aliases[ip] = ips[0];
    else for (const ip of ips) if (ip !== c.ips[0]) l.aliases[ip] = c.ips[0];
    return l;
  });
  return (
    <div className="fm-panel-sec">
      <div className="fm-panel-lbl">{isTarget ? t("Эти хопы — тот же узел") : t("Это тот же узел, что…")}</div>
      {linked.map(([a, b]) => (
        <div key={a} className="fm-zone-row">
          <span className="num" style={{ fontSize: 11.5 }}>{a} → {b}</span>
          <button className="btn ghost sm" onClick={() => update((l) => { delete l.aliases[a]; return l; })}>{t("Разъединить")}</button>
        </div>
      ))}
      <input className="input" placeholder={isTarget ? t("адрес или имя хопа") : t("цель или хоп: имя, адрес")} value={q} onChange={(e) => setQ(e.target.value)} />
      {shown.map((c) => (
        <div key={c.key} className="fm-zone-row" style={{ cursor: "pointer" }} onClick={() => { merge(c); setQ(""); }}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
          <span className="c-muted num" style={{ fontSize: 11 }}>{c.ips.join(", ")}</span>
        </div>
      ))}
      <div className="c-muted" style={{ fontSize: 11.5, marginTop: 6 }}>{t("Маршрутизатор отвечает в трассировке адресом своего интерфейса — на карте выходит два узла. Склейте их в один.")}</div>
    </div>
  );
}

/** Правка цели прямо с карты: группа, к чему подключена, скрыть. */
function TargetEdit({ s, n, groups, items, update, toast, onZone }: {
  s: TargetSummary;
  n: GNode;
  groups: string[];
  items: TargetSummary[];
  update: (fn: (l: Layout) => Layout) => void;
  toast: (msg: string, kind?: "ok" | "error") => void;
  onZone: (id: string) => void;
}) {
  const [grp, setGrp] = useState(s.group);
  const [newGrp, setNewGrp] = useState("");
  useEffect(() => { setGrp(s.group); setNewGrp(""); }, [s.id, s.group]);
  const move = (g: string) =>
    api.moveToGroup([s.id], g).then(() => toast(`${t("Перенесено в группу")} «${g}»`)).catch((e) => toast(String(e), "error"));
  const setParent = async (pid: string) => {
    try {
      const list = await api.listTargets();
      const tg = list.find((x) => x.id === s.id);
      if (!tg) return;
      await api.saveTarget({ ...tg, parentId: pid || null });
      toast(pid ? t("Подключение сохранено") : t("Подключение убрано — узел встанет по трассировке"));
    } catch (e) { toast(String(e), "error"); }
  };
  const others = items.filter((i) => i.id !== s.id).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return (
    <>
      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Подключён к (родитель)")}</div>
        <select className="input" value={s.parentId ?? ""} onChange={(e) => setParent(e.target.value)}>
          <option value="">{t("— по трассировке —")}</option>
          {others.map((i) => <option key={i.id} value={i.id}>{i.name} · {i.group}</option>)}
        </select>
        <div className="c-muted" style={{ fontSize: 11.5, marginTop: 6 }}>{t("Узел встанет на карте за выбранным. Это же родитель для оповещений: если он лежит, узел считается зависимым.")}</div>
      </div>
      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Группа")}</div>
        <div style={{ display: "flex", gap: 6 }}>
          <select className="input" value={grp} onChange={(e) => setGrp(e.target.value)}>
            {[...new Set([s.group, ...groups])].map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <button className="btn sm" disabled={grp === s.group} onClick={() => move(grp)}>{t("Перенести")}</button>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <input className="input" placeholder={t("или в новую группу")} value={newGrp} onChange={(e) => setNewGrp(e.target.value)} />
          <button className="btn sm" disabled={!newGrp.trim()} onClick={() => move(newGrp.trim())}>{t("Создать")}</button>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {n.site && <button className="btn ghost sm" onClick={() => onZone(n.site!)}>{t("Рамка группы")}</button>}
          <button className="btn ghost sm" title={t("Узел пропадёт с карты; вернуть — ⚙ → «Скрыто с карты»")} onClick={() => update((l) => { if (!l.excluded.targets.includes(s.id)) l.excluded.targets.push(s.id); return l; })}>{t("Скрыть с карты")}</button>
        </div>
      </div>
    </>
  );
}

/** Рамка группы: состав, переименование, свернуть, вернуть на место, скрыть. */
function ZonePanel({ id, group, zone, card, layout, edit, members, onPick, onClose, update, toast }: {
  id: string;
  group: string;
  zone: Zone | null;
  card: GNode | null;
  layout: Layout;
  edit: boolean;
  members: GNode[];
  onPick: (key: string) => void;
  onClose: () => void;
  update: (fn: (l: Layout) => Layout) => void;
  toast: (msg: string, kind?: "ok" | "error") => void;
}) {
  const [name, setName] = useState(group);
  useEffect(() => setName(group), [group]);
  const collapsed = layout.collapsed.includes(id);
  const st = zone?.st ?? card?.st ?? "ok";
  const total = zone?.total ?? card?.total ?? 0, bad = zone?.bad ?? card?.bad ?? 0;
  const rename = async () => {
    const nn = name.trim();
    if (!nn || nn === group) return;
    try {
      await api.renameGroup(group, nn);
      update((l) => {
        if (l.groups[group]) { l.groups[nn] = l.groups[group]; delete l.groups[group]; }
        return l;
      });
      toast(t("Группа переименована"));
      onClose();
    } catch (e) { toast(String(e), "error"); }
  };
  return (
    <aside className="fm-panel">
      <div className="fm-panel-h">
        <div className="fm-panel-ico" style={{ color: ST_COLOR[st], borderColor: ST_COLOR[st] }}>
          <NodeIcon type="building" variant={1} size={26} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="fm-panel-t">{group}</div>
          <div className="c-muted" style={{ fontSize: 12 }}>{t("Группа")} · {total - bad}/{total}</div>
        </div>
        <button className="btn ghost sm" onClick={onClose}>✕</button>
      </div>
      {edit && (
        <div className="fm-panel-sec">
          <div className="fm-panel-lbl">{t("Название группы")}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && rename()} />
            <button className="btn sm" disabled={!name.trim() || name.trim() === group} onClick={rename}>{t("Сохранить")}</button>
          </div>
        </div>
      )}
      {members.length > 0 && (
        <div className="fm-panel-sec">
          <div className="fm-panel-lbl">{t("Состав")} · {members.length}</div>
          {members.map((m) => (
            <div key={m.key} className="fm-zone-row" style={{ cursor: "pointer" }} onClick={() => onPick(m.key)}>
              <span style={{ color: ST_COLOR[m.st] }}>●</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{m.label}</span>
              <span className="c-muted num" style={{ fontSize: 11 }}>{m.sub.split(" · ")[0]}</span>
            </div>
          ))}
        </div>
      )}
      <div className="fm-panel-sec fm-panel-actions">
        <button className="btn ghost sm" onClick={() => update((l) => { l.collapsed = collapsed ? l.collapsed.filter((x) => x !== id) : [...l.collapsed, id]; return l; })}>
          {collapsed ? t("Развернуть") : t("Свернуть в карточку")}
        </button>
        {(layout.nodes[id]?.x != null || layout.nodes[ZONE(id)]?.x != null) && (
          <button className="btn ghost sm" onClick={() => update((l) => { delete l.nodes[id]; delete l.nodes[ZONE(id)]; return l; })}>{t("Вернуть на место")}</button>
        )}
        {edit && (
          <button className="btn ghost sm" title={t("Группа пропадёт с карты; вернуть — ⚙ → «Скрыто с карты»")} onClick={() => { update((l) => { if (!l.excluded.groups.includes(group)) l.excluded.groups.push(group); return l; }); onClose(); }}>
            {t("Скрыть группу с карты")}
          </button>
        )}
      </div>
    </aside>
  );
}

/** Что убрано с карты: группы, отдельные цели, хопы. */
function HiddenPanel({ layout, groups, items, onClose, update }: {
  layout: Layout;
  groups: string[];
  items: TargetSummary[];
  onClose: () => void;
  update: (fn: (l: Layout) => Layout) => void;
}) {
  const ex = new Set(layout.excluded.groups);
  const count = (g: string) => items.filter((i) => i.group === g).length;
  const hiddenTargets = items.filter((i) => layout.excluded.targets.includes(i.id));
  const hiddenHops = Object.entries(layout.nodes).filter(([, c]) => c.hidden).map(([k]) => k);
  return (
    <aside className="fm-panel">
      <div className="fm-panel-h">
        <div className="fm-panel-ico"><NodeIcon type="building" variant={1} size={26} /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="fm-panel-t">{t("Скрыто с карты")}</div>
          <div className="c-muted" style={{ fontSize: 12 }}>{t("Мониторинг скрытого продолжается")}</div>
        </div>
        <button className="btn ghost sm" onClick={onClose}>✕</button>
      </div>
      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Группы")} · {t("галочка — показывать на карте")}</div>
        {groups.filter((g) => count(g) > 0).map((g) => (
          <label key={g} className="fm-zone-row" style={{ gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={!ex.has(g)} onChange={(e) => update((l) => {
              l.excluded.groups = e.target.checked ? l.excluded.groups.filter((x) => x !== g) : [...new Set([...l.excluded.groups, g])];
              return l;
            })} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", opacity: ex.has(g) ? 0.5 : 1 }}>{g}</span>
            <span className="c-muted num" style={{ fontSize: 11 }}>{count(g)}</span>
          </label>
        ))}
      </div>
      {hiddenTargets.length > 0 && (
        <div className="fm-panel-sec">
          <div className="fm-panel-lbl">{t("Цели")}</div>
          {hiddenTargets.map((i) => (
            <div key={i.id} className="fm-zone-row">
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{i.name} <span className="c-muted" style={{ fontSize: 11 }}>{i.group}</span></span>
              <button className="btn ghost sm" onClick={() => update((l) => { l.excluded.targets = l.excluded.targets.filter((x) => x !== i.id); return l; })}>{t("Вернуть")}</button>
            </div>
          ))}
        </div>
      )}
      {hiddenHops.length > 0 && (
        <div className="fm-panel-sec">
          <div className="fm-panel-lbl">{t("Хопы")}</div>
          {hiddenHops.map((k) => (
            <div key={k} className="fm-zone-row">
              <span className="num" style={{ flex: 1 }}>{layout.nodes[k].label || k.slice(2)}</span>
              <button className="btn ghost sm" onClick={() => update((l) => { delete l.nodes[k].hidden; if (!Object.keys(l.nodes[k]).length) delete l.nodes[k]; return l; })}>{t("Вернуть")}</button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

const NEW_GROUP = "\u0000new";

/** Устройства, найденные сканом, которых нет в мониторинге: посмотреть и добавить. */
function FoundPanel({ scan, items, groups, subnet, onSubnet, onClose, toast }: {
  scan: ScanResult | null;
  items: TargetSummary[];
  groups: string[];
  subnet: string | null;
  onSubnet: (s: string | null) => void;
  onClose: () => void;
  toast: (msg: string, kind?: "ok" | "error") => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState(NEW_GROUP);
  const [newGroup, setNewGroup] = useState(t("Найденные устройства"));
  const [kind, setKind] = useState<CheckKind>("ping");
  const [busy, setBusy] = useState(false);
  const monitored = useMemo(() => new Set(items.flatMap((i) => [i.host, i.resolvedIp ?? ""]).filter(Boolean)), [items]);
  const all = (scan?.devices ?? []).filter((d) => !d.targetId && !monitored.has(d.ip) && !added.has(d.ip));
  const subnets = [...new Set(all.map((d) => d.subnet))].sort();
  const list = all.filter((d) => !subnet || d.subnet === subnet)
    .sort((a, b) => a.ip.split(".").map((x) => x.padStart(3, "0")).join(".").localeCompare(b.ip.split(".").map((x) => x.padStart(3, "0")).join(".")));
  const toggle = (ip: string) => setPicked((p) => { const n = new Set(p); if (n.has(ip)) n.delete(ip); else n.add(ip); return n; });
  const allOn = list.length > 0 && list.every((d) => picked.has(d.ip));
  const nameOf = (d: ScanDevice) => d.name ? d.name.split(".")[0] : d.vendor ? `${d.vendor.split(/[\s,]/)[0]} ${d.ip}` : d.ip;
  const add = async () => {
    const g = group === NEW_GROUP ? newGroup.trim() : group;
    if (!g) return;
    const chosen = list.filter((d) => picked.has(d.ip));
    setBusy(true);
    try {
      const n = await api.saveTargets(chosen.map((d) => ({ ...defaultTarget(), name: nameOf(d), host: d.ip, kind, group: g, notes: devLine(d) })));
      setAdded((a) => new Set([...a, ...chosen.map((d) => d.ip)]));
      setPicked(new Set());
      toast(`${t("Добавлено в мониторинг")}: ${n}`);
    } catch (e) { toast(String(e), "error"); } finally { setBusy(false); }
  };
  return (
    <aside className="fm-panel fm-found">
      <div className="fm-panel-h">
        <div className="fm-panel-ico" style={{ color: ST_COLOR.info, borderColor: ST_COLOR.info }}><NodeIcon type="device" variant={0} size={26} /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="fm-panel-t">{t("Не в мониторинге")}</div>
          <div className="c-muted" style={{ fontSize: 12 }}>{plural(all.length, "устройство", "устройства", "устройств")}{scan ? ` · ${t("скан")} ${fmtDateTime(scan.finished)}` : ""}</div>
        </div>
        <button className="btn ghost sm" onClick={onClose}>✕</button>
      </div>
      {subnets.length > 1 && (
        <div className="fm-panel-sec fm-chips">
          <button className={"chip" + (!subnet ? " on" : "")} onClick={() => onSubnet(null)}>{t("Все")}</button>
          {subnets.map((s) => <button key={s} className={"chip num" + (subnet === s ? " on" : "")} onClick={() => onSubnet(s)}>{s}</button>)}
        </div>
      )}
      <div className="fm-panel-sec" style={{ padding: "6px 16px" }}>
        {list.length === 0 && <div className="c-muted" style={{ padding: "8px 0" }}>{t("Всё найденное уже в мониторинге")}</div>}
        {list.length > 0 && (
          <label className="fm-zone-row" style={{ gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(list.map((d) => d.ip)))} />
            <span className="c-muted" style={{ flex: 1 }}>{t("Выбрать все")} ({list.length})</span>
          </label>
        )}
        {list.map((d) => (
          <div key={d.ip} className="fm-found-row">
            <div className="fm-found-main">
              <input type="checkbox" checked={picked.has(d.ip)} onChange={() => toggle(d.ip)} />
              <span className="fm-found-ico"><NodeIcon type={asNodeType(d.kind)} variant={0} size={18} /></span>
              <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setOpen(open === d.ip ? null : d.ip)}>
                <div className="fm-found-t"><span className="num">{d.ip}</span> {d.name && <span className="c-muted">{d.name}</span>}</div>
                <div className="fm-found-s">{devLine(d) || t("нет сведений")}{d.services.length ? ` · ${d.services.map((s) => s.name).slice(0, 5).join(", ")}` : ""}</div>
              </div>
            </div>
            {open === d.ip && <DeviceInfo d={d} />}
          </div>
        ))}
      </div>
      {list.length > 0 && (
        <div className="fm-panel-sec fm-found-add">
          <div className="fm-panel-lbl">{t("Добавить выбранные")} ({picked.size})</div>
          <select className="input" value={group} onChange={(e) => setGroup(e.target.value)}>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            <option value={NEW_GROUP}>{t("Новая группа…")}</option>
          </select>
          {group === NEW_GROUP && <input className="input" style={{ marginTop: 6 }} value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />}
          <select className="input" style={{ marginTop: 6 }} value={kind} onChange={(e) => setKind(e.target.value as CheckKind)}>
            <option value="ping">{t("Проверка")}: Ping</option>
            <option value="trace">{t("Проверка")}: {t("трассировка")}</option>
          </select>
          <button className="btn" style={{ marginTop: 8, width: "100%" }} disabled={!picked.size || busy || (group === NEW_GROUP && !newGroup.trim())} onClick={add}>
            {t("Добавить в мониторинг")}{picked.size ? ` · ${picked.size}` : ""}
          </button>
        </div>
      )}
    </aside>
  );
}

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
/** Подсеть из ввода: адрес без маски — /24; шире /22 не сканируем. */
function parseSubnet(v: string): { subnet: string; hosts: number } | null {
  const m = v.trim().match(CIDR);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  if (o.some((x) => x > 255)) return null;
  const bits = m[5] ? Number(m[5]) : 24;
  if (bits < 22 || bits > 32) return null;
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (ip & mask) >>> 0;
  const s = [net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join(".");
  return { subnet: `${s}/${bits}`, hosts: bits >= 31 ? 2 ** (32 - bits) : 2 ** (32 - bits) - 2 };
}

/** Что сканировать: трассировка до целей идёт всегда, поиск устройств — в отмеченных подсетях. */
function ScanDialog({ scan, onClose, onStart }: { scan: ScanResult | null; onClose: () => void; onStart: (subnets: string[]) => void }) {
  const [hints, setHints] = useState<SubnetHint[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState("");
  useEffect(() => {
    api.scanSubnets().then((h) => {
      setHints(h);
      const prev = new Set(scan?.subnets ?? []);
      setOn(new Set(h.filter((x) => x.local || prev.has(x.subnet)).map((x) => x.subnet)));
    }).catch(() => setHints([]));
  }, [scan]);
  const extraList = extra.split(/[\s,;]+/).filter(Boolean).map((v) => ({ v, p: parseSubnet(v) }));
  const bad = extraList.filter((x) => !x.p).map((x) => x.v);
  const subnets = [...new Set([...on, ...extraList.flatMap((x) => (x.p ? [x.p.subnet] : []))])];
  const hosts = subnets.reduce((a, s) => a + (parseSubnet(s)?.hosts ?? 0), 0);
  const toggle = (s: string) => setOn((p) => { const n = new Set(p); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(560px, calc(100vw - 40px))" }}>
        <div className="modal-h"><h2>{t("Сканировать сеть")}</h2><span style={{ flex: 1 }} /><button className="btn ghost sm" onClick={onClose}>✕</button></div>
        <div className="modal-b">
          <div className="c-muted" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
            {t("До каждой цели в мониторинге будет пройден маршрут (три прохода) — по нему строится дерево карты. В отмеченных подсетях программа найдёт все отвечающие устройства: пинг, таблица ARP, открытые порты, ответы служб — и попробует понять, что это за устройство и какая на нём система.")}
          </div>
          <div className="fm-panel-lbl" style={{ marginTop: 16 }}>{t("Искать устройства в подсетях")}</div>
          {hints == null && <div className="c-muted">{t("Загружаю…")}</div>}
          {hints?.map((h) => (
            <label key={h.subnet} className="fm-zone-row" style={{ gap: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={on.has(h.subnet)} onChange={() => toggle(h.subnet)} />
              <span className="num" style={{ flex: 1 }}>{h.subnet}</span>
              <span className="c-muted" style={{ fontSize: 11.5 }}>{h.local ? t("сеть этого компьютера") : plural(h.targets, "цель", "цели", "целей")}</span>
            </label>
          ))}
          {hints && hints.length > 1 && (
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button className="btn ghost sm" onClick={() => setOn(new Set(hints.map((h) => h.subnet)))}>{t("Отметить все")}</button>
              <button className="btn ghost sm" onClick={() => setOn(new Set())}>{t("Снять все")}</button>
            </div>
          )}
          <div className="fm-panel-lbl" style={{ marginTop: 14 }}>{t("Ещё подсети (через запятую)")}</div>
          <input className="input" placeholder="10.0.5.0/24, 192.168.10.0/23" value={extra} onChange={(e) => setExtra(e.target.value)} />
          {bad.length > 0 && <div className="c-warn" style={{ fontSize: 11.5, marginTop: 4 }}>{t("Не подходит")}: {bad.join(", ")} — {t("нужен адрес сети с маской от /22 до /32")}</div>}
          <div className="c-muted" style={{ fontSize: 11.5, marginTop: 12 }}>
            {subnets.length ? `${plural(subnets.length, "подсеть", "подсети", "подсетей")} · ${plural(hosts, "адрес", "адреса", "адресов")}` : t("Только маршруты до целей, без поиска устройств")}
            {hosts > 2000 ? ` · ${t("это займёт несколько минут")}` : ""}
          </div>
        </div>
        <div className="modal-f">
          <button className="btn ghost" onClick={onClose}>{t("Отмена")}</button>
          <button className="btn" disabled={bad.length > 0} onClick={() => onStart(subnets)}>{t("Начать скан")}</button>
        </div>
      </div>
    </div>
  );
}

/** Кто обслуживает узел: оператор и как с ним связаться. */
function MapOperator({ id }: { id: string }) {
  const [ops, setOps] = useState<TargetOperator[] | null>(null);
  useEffect(() => { setOps(null); api.targetOperators(id).then(setOps).catch(() => setOps([])); }, [id]);
  if (!ops?.length) return null;
  const o = ops[0];
  return (
    <div className="fm-panel-sec">
      <div className="fm-panel-lbl">{t("Оператор")}{o.via === "hint" ? ` · ${t("подсказка")}` : ""}</div>
      <div style={{ fontWeight: 600 }}>{o.operator.name}</div>
      {o.service?.number && <div className="num c-muted" style={{ fontSize: 12 }}>{t("Услуга")} {o.service.number}</div>}
      {o.operator.phones.slice(0, 2).map((p, k) => (
        <div key={k} className="fm-dev-row"><span>{p.label || t("Телефон")}</span><b className="num" style={{ userSelect: "text" }}>{p.value}</b></div>
      ))}
      {o.operator.emails.slice(0, 1).map((p, k) => (
        <div key={k} className="fm-dev-row"><span>{p.label || t("Почта")}</span><b className="num" style={{ userSelect: "text" }}>{p.value}</b></div>
      ))}
    </div>
  );
}
