import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TargetSummary, Topology } from "../types";
import { KIND_LABEL } from "../types";
import { api } from "../api";
import { fmtMs, fmtPct, plural } from "../format";
import { problemText } from "../problem";
import { t } from "../i18n";
import { NODE_TYPES, NodeGlyph, NodeIcon, type NodeType } from "../map/icons";
import { buildGraph, cubicPts, DIM, FAM, inOf, nodeRect, outOf, parseLayout, smooth, splitAt, ST_COLOR, ZONE, type Bead, type Dir, type GEdge, type GNode, type Layout, type NodeCfg, type P, type Rect, type St, type Zone } from "../map/graph";

const MIN_K = 0.12;
const MAX_K = 3;
const TOPO_EVERY_MS = 8000;

interface View { k: number; tx: number; ty: number }
type Drag = { kind: "node" | "zone"; key: string; sx: number; sy: number; dx: number; dy: number; moved: boolean; pick?: string };

/**
 * Карта сети: иерархическая схема от этого компьютера к целям; цели — рамками групп,
 * промежуточные хопы — точками на линиях; цвет отрезка показывает,
 * доходят ли пакеты до этой точки, поэтому обрыв виден ровно там, где он есть.
 */
export function NetworkMap({ items, groups, onOpen, toast }: {
  items: TargetSummary[];
  /** Все группы (и пустые). */
  groups: string[];
  onOpen: (id: string) => void;
  toast: (msg: string, kind?: "ok" | "error") => void;
}) {
  const [topo, setTopo] = useState<Topology | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [view, setView] = useState<View>({ k: 1, tx: 80, ty: 80 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pan, setPan] = useState<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [groupsOpen, setGroupsOpen] = useState(false);
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
  }, []);
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

  // Схема строится по зафиксированным маршрутам и меняется только по кнопке «Обновить схему»;
  // живыми остаются состояния: задержки, потери, где обрывается путь.
  const same = (a?: (string | null)[], b?: (string | null)[]) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  const eff = useMemo<Topology | null>(() => {
    if (!topo) return null;
    const fr = layout?.frozen;
    if (!fr) return topo;
    const live = new Map(topo.routes.map((r) => [r.targetId, r]));
    const routes = Object.entries(fr.routes).map(([id, hops]) => {
      const l = live.get(id);
      return { targetId: id, hops, reached: l?.reached ?? true, at: l?.at ?? 0, live: false, reach: l && (same(l.hops, hops) || l.reach != null) ? l.reach : null };
    });
    for (const r of topo.routes) if (!fr.routes[r.targetId]) routes.push(r);
    return { ...topo, localIp: fr.localIp ?? topo.localIp, routes };
  }, [topo, layout?.frozen]);
  const changed = useMemo(() => {
    const fr = layout?.frozen;
    if (!topo || !fr) return 0;
    return topo.routes.filter((r) => r.hops.length && fr.routes[r.targetId] && !same(r.hops, fr.routes[r.targetId])).length;
  }, [topo, layout?.frozen]);
  const freeze = useCallback((all: boolean) => {
    if (!topo) return;
    update((l) => {
      const routes: Record<string, (string | null)[]> = all || !l.frozen ? {} : { ...l.frozen.routes };
      if (!all && l.frozen) Object.assign(routes, l.frozen.routes);
      for (const r of topo.routes) if (r.hops.length) routes[r.targetId] = r.hops;
      return { ...l, frozen: { localIp: topo.localIp, routes } };
    });
  }, [topo, update]);
  // Первый раз фиксируем схему, когда маршруты почти всех целей уже известны.
  useEffect(() => {
    if (!layout || layout.frozen || !topo) return;
    const n = items.filter((i) => i.enabled).length;
    if (topo.routes.filter((r) => r.hops.length).length >= Math.max(1, n * 0.8) || topo.pending === 0) freeze(true);
  }, [layout, topo, items, freeze]);

  const graph = useMemo(() => (layout ? buildGraph(eff, items, layout) : null), [eff, items, layout]);

  // Во время перетаскивания двигаем поверх раскладки, в базу — по отпусканию.
  const pos = (n: { key: string; kind?: string; x: number; y: number; site?: string; fam?: string; pinned?: boolean }) => {
    if (!drag || !drag.moved) return { x: n.x, y: n.y };
    if (drag.kind === "node" && drag.key === n.key) return { x: n.x + drag.dx, y: n.y + drag.dy };
    if (drag.kind === "zone" && (n.site === drag.key || n.fam === drag.key) && !(n.kind === "zone" && n.pinned && n.fam === drag.key)) return { x: n.x + drag.dx, y: n.y + drag.dy };
    return { x: n.x, y: n.y };
  };
  const zoneShift = (z: Zone) => (drag?.kind === "zone" && drag.moved && (z.site === drag.key || z.fam === drag.key) ? { dx: drag.dx, dy: drag.dy } : { dx: 0, dy: 0 });

  const fit = useCallback(() => {
    if (!graph) return;
    const { x0, y0, x1, y1 } = graph.bounds;
    const pad = 60;
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(size.w / (x1 - x0 + pad * 2), size.h / (y1 - y0 + pad * 2))));
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

  const startDrag = (kind: Drag["kind"], key: string, e: React.MouseEvent, pick?: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const w = toWorld(e.clientX, e.clientY);
    setDrag({ kind, key, sx: w.x, sy: w.y, dx: 0, dy: 0, moved: false, pick });
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
      if (!drag.moved) setSel(drag.pick ?? (drag.kind === "zone" ? "zone:" + drag.key : drag.key));
      else if (drag.kind === "zone") {
        if (drag.key.startsWith("F:")) {
          // Центральная группа хранит сдвиг.
          const c = layout.nodes[drag.key] ?? {};
          setNode(drag.key, { x: Math.round((c.x ?? 0) + drag.dx), y: Math.round((c.y ?? 0) + drag.dy) });
        } else {
          const z = graph.zones.find((x) => x.site === drag.key);
          if (z) setNode(drag.key, { x: Math.round(z.x + z.w / 2 + drag.dx), y: Math.round(z.y + z.h / 2 + drag.dy) });
        }
      } else {
        const n = graph.byKey.get(drag.key)!;
        // Закрепляем центр прямоугольника узла (с подписью).
        const d = DIM[n.kind];
        setNode(drag.key, { x: Math.round(n.x + drag.dx), y: Math.round(n.y + drag.dy + (d.bottom - d.top) / 2) });
      }
      setDrag(null);
    }
    if (pan) {
      if (!pan.moved) setSel(null);
      setPan(null);
    }
  };

  const search = () => {
    if (!graph || !query.trim()) return;
    const q = query.trim().toLowerCase();
    const n = graph.nodes.find((x) => x.label.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q));
    if (n) { setSel(n.key); centerOn(n.x, n.y); return; }
    const b = [...graph.beads.values()].find((x) => x.ip.includes(q) || x.label.toLowerCase().includes(q));
    if (b) { setSel(b.key); centerOn(b.x, b.y); return; }
    toast(t("Узел не найден"), "error");
  };

  if (!layout || !graph) return <div className="fm-empty">{t("Загружаю карту…")}</div>;

  const k = view.k;
  const focus = sel ?? hover?.key ?? null;
  const selNode = sel ? graph.byKey.get(sel) ?? null : null;
  const selBead = sel ? graph.beads.get(sel) ?? null : null;
  const selZone = sel?.startsWith("zone:") ? sel.slice(5) : null;
  const hovNode = hover ? graph.byKey.get(hover.key) ?? null : null;
  const hovBead = hover ? graph.beads.get(hover.key) ?? null : null;
  const hiddenCount = Object.values(layout.nodes).filter((c) => c.hidden).length;
  const movedCount = Object.values(layout.nodes).filter((c) => c.x != null).length;
  const problems = items.filter((i) => i.enabled && (i.health === "down" || i.health === "crit" || i.health === "bad" || i.health === "warn")).length;
  const groupsN = new Set(items.filter((i) => i.enabled).map((i) => i.group)).size;
  const allGroups = [...new Set([...groups, ...items.map((i) => i.group), ...Object.values(layout.parents)])].filter(Boolean).sort((a, b) => a.localeCompare(b, "ru"));
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
    // Концы — всегда по центру стороны (под подписью родителя, над узлом), середина — по раскладке.
    const a0 = outOf(ra.r, dir), b0 = inOf(rb.r, dir);
    const line = e.pts.length >= 3 && !ra.moved && !rb.moved ? smooth([a0, ...e.pts.slice(1, -1), b0], dir) : cubicPts(a0, b0, dir);
    geo.set(e.key, { line, ...splitAt(line, e.beads.length) });
  }
  const renderEdge = (e: GEdge) => {
    const hi = focus != null && (e.a === focus || e.b === focus || e.beads.some((b) => b.key === focus) || (!!selNode?.site && (e.a === selNode.site || e.b === selNode.site)));
    if (e.kind === "link") {
      const na = graph.byKey.get(e.a), nb = graph.byKey.get(e.b);
      if (!na || !nb) return null;
      const lhi = hi || focus === e.a || focus === e.b;
      if (!layout.opts.tunnels && !lhi && e.st !== "down") return null;
      return <Link key={e.key} e={e} a={pos(na)} b={pos(nb)} k={k} hi={lhi} />;
    }
    const g = geo.get(e.key);
    return g ? <Edge key={e.key} e={e} g={g} flow={layout.opts.flow} hi={hi} /> : null;
  };
  const excludedN = layout.excluded.groups.length + layout.excluded.targets.length;
  const reset = () => {
    update((l) => {
      for (const [key, c] of Object.entries(l.nodes)) {
        delete c.x; delete c.y;
        if (!Object.keys(c).length) delete l.nodes[key];
      }
      l.collapsed = [];
      return l;
    });
    freeze(true);
    fitted.current = false;
    setSel(null);
    toast(t("Схема собрана заново по свежим маршрутам"));
  };

  return (
    <div className="fm">
      <div className="fm-bar">
        <div className="fm-search">
          <input className="input" placeholder={t("Найти узел: имя, IP…")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
        </div>
        <div className="fm-zoom">
          <button className="btn ghost sm" onClick={() => zoomAt(1 / 1.25)} title={t("Мельче")}>−</button>
          <span className="num">{Math.round(k * 100)}%</span>
          <button className="btn ghost sm" onClick={() => zoomAt(1.25)} title={t("Крупнее")}>+</button>
          <button className="btn ghost sm" onClick={fit}>{t("Вписать")}</button>
        </div>
        <label className="check"><input type="checkbox" checked={layout.opts.flow} onChange={(e) => update((l) => ({ ...l, opts: { ...l.opts, flow: e.target.checked } }))} /><span className="sw" /><span>{t("Поток")}</span></label>
        <label className="check"><input type="checkbox" checked={layout.opts.hopLabels} onChange={(e) => update((l) => ({ ...l, opts: { ...l.opts, hopLabels: e.target.checked } }))} /><span className="sw" /><span>{t("Адреса хопов")}</span></label>
        <label className="check"><input type="checkbox" checked={layout.opts.collapseNet} onChange={(e) => update((l) => ({ ...l, opts: { ...l.opts, collapseNet: e.target.checked } }))} /><span className="sw" /><span>{t("Свернуть интернет")}</span></label>
        <label className="check" title={t("Показывать все туннели (GRE и т. п.) дугами; иначе — только упавшие и у выбранного узла")}><input type="checkbox" checked={layout.opts.tunnels} onChange={(e) => update((l) => ({ ...l, opts: { ...l.opts, tunnels: e.target.checked } }))} /><span className="sw" /><span>{t("Туннели")}</span></label>
        <select className="input" style={{ width: "auto" }} value={layout.opts.dir} onChange={(e) => update((l) => ({ ...l, opts: { ...l.opts, dir: e.target.value as Dir } }))} title={t("Направление схемы")}>
          <option value="TB">{t("Сверху вниз")}</option>
          <option value="BT">{t("Снизу вверх")}</option>
          <option value="LR">{t("Слева направо")}</option>
        </select>
        <label className="check" title={t("Дерево строится по родителям, заданным в целях; выключено — только по трассировке")}><input type="checkbox" checked={layout.opts.byDeps} onChange={(e) => update((l) => ({ ...l, opts: { ...l.opts, byDeps: e.target.checked } }))} /><span className="sw" /><span>{t("По зависимостям")}</span></label>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => { setSel(null); setGroupsOpen((v) => !v); }}>{t("Группы на карте")}</button>
        <button className={"btn sm" + (changed ? "" : " ghost")} title={t("Схема не меняется сама. Эта кнопка берёт свежие трассировки, ручные правки остаются")} onClick={() => { freeze(false); toast(t("Маршруты обновлены")); }}>
          {t("Обновить маршруты")}{changed ? ` · ${changed}` : ""}
        </button>
        <button className="btn ghost sm" title={t("Собрать схему автоматически с нуля: свежие маршруты, без ручных положений и свёрнутых групп. Подписи, иконки, центральные группы и исключения остаются")} onClick={reset}>
          {t("Собрать заново")}
        </button>
        {excludedN > 0 && <button className="btn ghost sm" onClick={() => { setSel(null); setGroupsOpen(true); }}>{t("Не на карте")}: {excludedN}</button>}
        {hiddenCount > 0 && <button className="btn ghost sm" onClick={() => update((l) => { for (const c of Object.values(l.nodes)) delete c.hidden; return l; })}>{t("Скрытые хопы")}: {hiddenCount}</button>}
        {movedCount > 0 && (
          <button className="btn ghost sm" title={t("Сбросить положения, заданные вручную")} onClick={() => update((l) => { for (const c of Object.values(l.nodes)) { delete c.x; delete c.y; } return l; })}>
            {t("Вернуть всё на места")}
          </button>
        )}
      </div>

      <div className="fm-body">
        <div
          ref={wrap}
          className={"fm-canvas" + (pan?.moved ? " panning" : "") + (drag?.moved ? " dragging" : "")}
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
                <circle cx="1" cy="1" r="1" fill="rgba(255,255,255,0.05)" />
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
                    onClick={(ev) => { ev.stopPropagation(); setSel(bd.key); }}
                    onHover={(on, ev) => setHover(on && ev ? { key: bd.key, x: ev.clientX, y: ev.clientY } : null)} />
                ));
              })}
              {graph.zones.map((z) => <ZoneTitle key={z.key} z={z} shift={zoneShift(z)} k={k} onDown={(e) => startDrag("zone", z.site, e)} />)}
              {graph.nodes.map((n) => (
                <Node key={n.key} n={n} p={pos(n)} k={k} selected={sel === n.key || (n.kind === "zone" && selZone === n.site)}
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
            <span className="c-muted">· {t("точки на линиях — промежуточные хопы · узел и рамку можно перетащить")}</span>
          </div>
          <div className="fm-stat">
            {plural(items.filter((i) => i.enabled).length, "цель", "цели", "целей")} · {plural(topo?.hops.length ?? 0, "хоп", "хопа", "хопов")} · {plural(groupsN, "группа", "группы", "групп")}
            {problems > 0 && <> · <b className="c-warn">{plural(problems, "проблема", "проблемы", "проблем")}</b></>}
            {(topo?.pending ?? 0) > 0 && <> · {t("маршрут определяется")}: {topo!.pending}</>}
          </div>

          {hovNode && hovNode.kind !== "zone" && !drag?.moved && !pan?.moved && <Tip n={hovNode} x={hover!.x} y={hover!.y} box={wrap.current!.getBoundingClientRect()} />}
          {hovBead && !drag?.moved && !pan?.moved && <BeadTip b={hovBead} x={hover!.x} y={hover!.y} box={wrap.current!.getBoundingClientRect()} />}
        </div>

        {(selNode && selNode.kind !== "zone" || selBead) && (
          <Inspector
            n={selNode}
            bead={selBead}
            layout={layout}
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
        {(selZone || selNode?.kind === "zone") && (() => {
          const id = selZone ?? selNode!.site!;
          if (id.startsWith("F:")) {
            return <FamPanel name={id.slice(2)} zone={zoneByKey.get(id) ?? null} layout={layout} groups={allGroups} onClose={() => setSel(null)} update={update} onRenamed={(nn) => setSel("zone:" + FAM(nn))} />;
          }
          const group = id.slice(2);
          const z = zoneByKey.get(id) ?? null;
          const card = graph.byKey.get(ZONE(group)) ?? null;
          return <ZonePanel id={id} group={group} title={group} zone={z} card={card} layout={layout} groups={allGroups}
            members={(z?.members ?? []).map((m) => graph.byKey.get(m)).filter((m): m is GNode => !!m)}
            onPick={(key) => setSel(key)} onClose={() => setSel(null)} update={update} toast={toast} />;
        })()}
        {groupsOpen && !sel && <GroupsPanel layout={layout} groups={allGroups} items={items} onClose={() => setGroupsOpen(false)} update={update} toast={toast} onPick={(id) => setSel(id)} />}
      </div>
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
function ZoneTitle({ z, shift, k, onDown }: { z: Zone; shift: { dx: number; dy: number }; k: number; onDown: (e: React.MouseEvent) => void }) {
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
      <g className="fm-zone-title" onMouseDown={onDown} style={{ cursor: "move" }}>
        <rect x={x} y={y - h - 2 / k} width={tw} height={h} rx={h / 2} fill="#070a0d" fillOpacity={0.92} stroke={c} strokeOpacity={z.bad ? 0.8 : 0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <text x={x + fs * 0.7} y={y - 2 / k - h * 0.3} className={"fm-zone-t " + z.kind} fontSize={fs} style={{ strokeWidth: 0 }}>
          {z.title}
          {withN && <tspan dx={fs * 0.6} className="fm-zone-n" fill={z.bad ? c : undefined}>{counter}</tspan>}
        </text>
      </g>
    );
  }
  const fs = far ? Math.min(base * 1.3, screen / k) : base;
  return (
    <g className="fm-zone-title" onMouseDown={onDown} style={{ cursor: site ? "move" : "pointer" }}>
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
          <rect x={-fs * 2.2} y={-fs * 0.85} width={fs * 4.4} height={fs * 1.7} rx={fs * 0.85} fill="#070a0d" stroke={c} strokeOpacity={0.7} vectorEffect="non-scaling-stroke" />
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
      <circle r={r} fill={c} stroke="#05070a" strokeWidth={1.2} />
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

  // Свёрнутая площадка — карточка с итогом.
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
        {k > 0.6 && n.sub && <text y={s / 2 + 28} textAnchor="middle" className="fm-sub">{n.sub}</text>}
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
      {(lod > 0 || problem || right) && <text x={lx} y={ly} textAnchor={anchor} className={right ? "fm-local-label" : "fm-label"}>{cut(n.label, right ? 30 : 19)}</text>}
      {(lod > 1 || right) && n.sub && <text x={lx} y={ly + (right ? 18 : 14)} textAnchor={anchor} className="fm-sub">{cut(n.sub, 22)}</text>}
      {lod > 0 && problem && why && <text x={lx} y={ly + (lod > 1 && n.sub ? 28 : 14)} textAnchor={anchor} className="fm-why" fill={c}>{cut(why, 24)}</text>}
    </g>
  );
}

function Tip({ n, x, y, box }: { n: GNode; x: number; y: number; box: DOMRect }) {
  const left = Math.min(x - box.left + 16, box.width - 290);
  const top = Math.min(y - box.top + 14, box.height - 150);
  const s = n.target;
  return (
    <div className="fm-tip" style={{ left, top }}>
      <div className="fm-tip-h" style={{ color: ST_COLOR[n.st] }}>{n.label}</div>
      {n.sub && <div className="c-muted num">{n.sub}</div>}
      {s && <div>{KIND_LABEL[s.kind]} · {s.group}</div>}
      {s && problemText(s) && <div style={{ color: ST_COLOR[n.st] }}>{problemText(s)}</div>}
      {s && s.health !== "down" && s.health !== "dependent" && (
        <div className="c-muted">{t("задержка")} <b className="num c-text">{fmtMs(s.avgRtt)} {t("мс")}</b> · {t("потери")} <b className="num c-text">{fmtPct(s.lossPct)}%</b></div>
      )}
      {n.kind === "hop" && (
        <div className="c-muted">
          {t("развилка")} · {t("через узел идут")} {plural(n.pass, "маршрут", "маршрута", "маршрутов")}
          {n.lost > 0 && <span style={{ color: ST_COLOR[n.lost === n.pass ? "down" : "warn"] }}> · {t("обрываются")}: {n.lost}</span>}
        </div>
      )}
    </div>
  );
}

function BeadTip({ b, x, y, box }: { b: Bead; x: number; y: number; box: DOMRect }) {
  const left = Math.min(x - box.left + 16, box.width - 290);
  const top = Math.min(y - box.top + 14, box.height - 130);
  return (
    <div className="fm-tip" style={{ left, top }}>
      <div className="fm-tip-h num" style={{ color: ST_COLOR[b.st] }}>{b.label}</div>
      {b.label !== b.ip && <div className="c-muted num">{b.ip}</div>}
      <div className="c-muted">
        {t("промежуточный хоп")}
        {b.hop?.rtt != null && <> · {t("задержка")} <b className="num c-text">{fmtMs(b.hop.rtt, 1)} {t("мс")}</b></>}
        {b.hop?.loss != null && <> · {t("потери")} <b className="num c-text">{fmtPct(b.hop.loss)}%</b></>}
      </div>
      {b.lost > 0 && <div style={{ color: ST_COLOR[b.lost === b.pass ? "down" : "warn"] }}>{b.lost === b.pass ? t("пакеты сюда не доходят") : `${t("обрываются")} ${b.lost} ${t("из")} ${b.pass}`}</div>}
    </div>
  );
}

function Inspector({ n, bead, layout, onClose, onOpen, setNode, update, groupKeys, groups, items, toast, onZone }: {
  n: GNode | null;
  bead: Bead | null;
  layout: Layout;
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
  const kindLabel = n?.kind === "local" ? t("Этот компьютер") : n?.kind === "net" ? t("Интернет") : isHop ? (n ? t("Развилка маршрутов") : t("Промежуточный хоп")) : KIND_LABEL[s!.kind];
  const pass = n?.pass ?? bead!.pass, lost = n?.lost ?? bead!.lost;
  const hop = n?.hop ?? bead?.hop;
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
        {isHop && (
          <div className="fm-kv">
            <div>{t("задержка")}<b className="num">{hop?.rtt == null ? "—" : fmtMs(hop.rtt, 1)}</b></div>
            <div>{t("потери")}<b className="num">{hop?.loss == null ? "—" : fmtPct(hop.loss) + "%"}</b></div>
            <div>{t("маршрутов")}<b className="num">{pass}</b></div>
          </div>
        )}
        {isHop && lost > 0 && (
          <div style={{ color: ST_COLOR[lost === pass ? "down" : "warn"], marginTop: 8 }}>
            {lost === pass ? t("Все маршруты через этот узел сейчас обрываются") : `${t("Обрываются")} ${lost} ${t("из")} ${pass} ${t("маршрутов через этот узел")}`}
          </div>
        )}
        {s && <button className="btn" style={{ marginTop: 10 }} onClick={() => onOpen(s.id)}>{t("Открыть подробности")}</button>}
      </div>

      {s && <TargetEdit s={s} n={n!} layout={layout} groups={groups} items={items} update={update} toast={toast} onZone={onZone} />}

      {n?.kind !== "local" && (
        <div className="fm-panel-sec">
          <div className="fm-panel-lbl">{t("Подпись на карте")}</div>
          <input className="input" value={cfg.label ?? ""} placeholder={isHop ? t("например, шлюз провайдера") : s?.name} onChange={(e) => setNode(key, { label: e.target.value })} />
        </div>
      )}

      {n?.kind !== "local" && n?.kind !== "net" && (
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

      <div className="fm-panel-sec fm-panel-actions">
        {n?.pinned && <button className="btn ghost sm" onClick={() => setNode(key, { x: undefined, y: undefined })}>{t("Вернуть на место")}</button>}
        {isHop && <button className="btn ghost sm" onClick={() => { setNode(key, { hidden: true }); onClose(); }}>{t("Скрыть хоп")}</button>}
      </div>
    </aside>
  );
}

/** Центральная группа для группы: выбор из существующих центральных и остальных групп. */
function CentralSelect({ group, layout, groups, update }: { group: string; layout: Layout; groups: string[]; update: (fn: (l: Layout) => Layout) => void }) {
  const [nn, setNn] = useState("");
  const centrals = [...new Set(Object.values(layout.parents))];
  const cur = layout.parents[group] ?? "";
  const set = (v: string) => update((l) => {
    if (v && v !== group) l.parents[group] = v; else delete l.parents[group];
    return l;
  });
  const options = [...new Set([...centrals, ...groups])].filter((g) => g !== group).sort((a, b) => a.localeCompare(b, "ru"));
  return (
    <>
      <select className="input" value={cur} onChange={(e) => set(e.target.value)}>
        <option value="">{t("— не входит —")}</option>
        {options.map((g) => <option key={g} value={g}>{centrals.includes(g) ? "★ " : ""}{g}</option>)}
      </select>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <input className="input" placeholder={t("новая центральная группа")} value={nn} onChange={(e) => setNn(e.target.value)} />
        <button className="btn sm" disabled={!nn.trim()} onClick={() => { set(nn.trim()); setNn(""); }}>{t("Создать")}</button>
      </div>
    </>
  );
}

/** Правка цели прямо с карты: группа, центральная группа, к чему подключена. */
function TargetEdit({ s, n, layout, groups, items, update, toast, onZone }: {
  s: TargetSummary;
  n: GNode;
  layout: Layout;
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
          {n.fam && <button className="btn ghost sm" onClick={() => onZone(n.fam!)}>{t("Центральная группа")} «{n.fam.slice(2)}»</button>}
          <button className="btn ghost sm" title={t("Узел пропадёт с карты; вернуть — в «Группы на карте»")} onClick={() => update((l) => { if (!l.excluded.targets.includes(s.id)) l.excluded.targets.push(s.id); return l; })}>{t("Скрыть с карты")}</button>
        </div>
      </div>
      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Группа")} «{s.group}» {t("входит в центральную")}</div>
        <CentralSelect group={s.group} layout={layout} groups={groups} update={update} />
      </div>
      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Подключён к (родитель)")}</div>
        <select className="input" value={s.parentId ?? ""} onChange={(e) => setParent(e.target.value)}>
          <option value="">{t("— по трассировке —")}</option>
          {others.map((i) => <option key={i.id} value={i.id}>{i.name} · {i.group}</option>)}
        </select>
        <div className="c-muted" style={{ fontSize: 11.5, marginTop: 6 }}>{t("Узел встанет на карте за выбранным. Это же родитель для оповещений: если он лежит, узел считается зависимым.")}</div>
      </div>
    </>
  );
}

/** Рамка группы: состав, переименование, центральная группа, свернуть, вернуть на место. */
function ZonePanel({ id, group, title, zone, card, layout, groups, members, onPick, onClose, update, toast }: {
  id: string;
  group: string;
  title: string;
  zone: Zone | null;
  card: GNode | null;
  layout: Layout;
  groups: string[];
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
        if (l.parents[group]) { l.parents[nn] = l.parents[group]; delete l.parents[group]; }
        for (const k2 of Object.keys(l.parents)) if (l.parents[k2] === group) l.parents[k2] = nn;
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
          <div className="fm-panel-t">{title}</div>
          <div className="c-muted" style={{ fontSize: 12 }}>{t("Группа")} · {total - bad}/{total}</div>
        </div>
        <button className="btn ghost sm" onClick={onClose}>✕</button>
      </div>
      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Название группы")}</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && rename()} />
          <button className="btn sm" disabled={!name.trim() || name.trim() === group} onClick={rename}>{t("Сохранить")}</button>
        </div>
      </div>
      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Входит в центральную группу")}</div>
        <CentralSelect group={group} layout={layout} groups={groups} update={update} />
      </div>
      {members.length > 0 && (
        <div className="fm-panel-sec">
          <div className="fm-panel-lbl">{t("Состав")} · {t("здесь")} {members.length}</div>
          {members.map((m) => (
            <div key={m.key} className="fm-zone-row" style={{ cursor: "pointer" }} onClick={() => onPick(m.key)}>
              <span style={{ color: ST_COLOR[m.st] }}>●</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{m.label}</span>
              <span className="c-muted num" style={{ fontSize: 11 }}>{m.sub.split(" · ")[0]}</span>
            </div>
          ))}
          <div className="c-muted" style={{ fontSize: 11.5, marginTop: 6 }}>{t("Нажмите на узел, чтобы перенести его в другую группу или подключить к другому узлу.")}</div>
        </div>
      )}
      <div className="fm-panel-sec fm-panel-actions">
        <button className="btn ghost sm" onClick={() => update((l) => { l.collapsed = collapsed ? l.collapsed.filter((x) => x !== id) : [...l.collapsed, id]; return l; })}>
          {collapsed ? t("Развернуть") : t("Свернуть в карточку")}
        </button>
        {(layout.nodes[id]?.x != null || layout.nodes[ZONE(group)]?.x != null) && (
          <button className="btn ghost sm" onClick={() => update((l) => { delete l.nodes[id]; delete l.nodes[ZONE(group)]; return l; })}>{t("Вернуть на место")}</button>
        )}
        <button className="btn ghost sm" title={t("Группа пропадёт с карты; вернуть — в «Группы на карте»")} onClick={() => { update((l) => { if (!l.excluded.groups.includes(group)) l.excluded.groups.push(group); return l; }); onClose(); }}>
          {t("Скрыть группу с карты")}
        </button>
      </div>
    </aside>
  );
}

/** Центральная группа: какие группы в неё входят, переименовать, расформировать. */
function FamPanel({ name, zone, layout, groups, onClose, update, onRenamed }: {
  name: string;
  zone: Zone | null;
  layout: Layout;
  groups: string[];
  onClose: () => void;
  update: (fn: (l: Layout) => Layout) => void;
  onRenamed: (name: string) => void;
}) {
  const [nn, setNn] = useState(name);
  useEffect(() => setNn(name), [name]);
  const inFam = Object.entries(layout.parents).filter(([, p]) => p === name).map(([g]) => g).sort((a, b) => a.localeCompare(b, "ru"));
  const others = groups.filter((g) => g !== name && !inFam.includes(g));
  const rename = () => {
    const v = nn.trim();
    if (!v || v === name) return;
    update((l) => {
      for (const g of Object.keys(l.parents)) if (l.parents[g] === name) l.parents[g] = v;
      const off = l.nodes[FAM(name)];
      if (off) { l.nodes[FAM(v)] = off; delete l.nodes[FAM(name)]; }
      return l;
    });
    onRenamed(v);
  };
  const st = zone?.st ?? "ok";
  return (
    <aside className="fm-panel">
      <div className="fm-panel-h">
        <div className="fm-panel-ico" style={{ color: ST_COLOR[st], borderColor: ST_COLOR[st] }}>
          <NodeIcon type="building" variant={1} size={26} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="fm-panel-t">{name}</div>
          <div className="c-muted" style={{ fontSize: 12 }}>{t("Центральная группа")}{zone ? ` · ${zone.total - zone.bad}/${zone.total}` : ""}</div>
        </div>
        <button className="btn ghost sm" onClick={onClose}>✕</button>
      </div>
      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Название")}</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input className="input" value={nn} onChange={(e) => setNn(e.target.value)} onKeyDown={(e) => e.key === "Enter" && rename()} />
          <button className="btn sm" disabled={!nn.trim() || nn.trim() === name} onClick={rename}>{t("Сохранить")}</button>
        </div>
      </div>
      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Входят группы")}</div>
        {groups.includes(name) && <div className="fm-zone-row"><span>{name}</span><span className="c-muted" style={{ fontSize: 11 }}>{t("своя")}</span></div>}
        {inFam.map((g) => (
          <div key={g} className="fm-zone-row">
            <span>{g}</span>
            <button className="btn ghost sm" onClick={() => update((l) => { delete l.parents[g]; return l; })}>{t("Убрать")}</button>
          </div>
        ))}
        {others.length > 0 && (
          <select className="input" style={{ marginTop: 8 }} value="" onChange={(e) => { const g = e.target.value; if (g) update((l) => { l.parents[g] = name; return l; }); }}>
            <option value="">{t("Добавить группу…")}</option>
            {others.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
      </div>
      <div className="fm-panel-sec fm-panel-actions">
        {layout.nodes[FAM(name)]?.x != null && (
          <button className="btn ghost sm" onClick={() => update((l) => { delete l.nodes[FAM(name)]; return l; })}>{t("Вернуть на место")}</button>
        )}
        <button className="btn ghost sm" onClick={() => { update((l) => { for (const g of Object.keys(l.parents)) if (l.parents[g] === name) delete l.parents[g]; return l; }); onClose(); }}>{t("Расформировать")}</button>
      </div>
    </aside>
  );
}

/** Все группы разом: показывать ли на карте, в какую центральную входит, удалить. */
function GroupsPanel({ layout, groups, items, onClose, update, toast, onPick }: {
  layout: Layout;
  groups: string[];
  items: TargetSummary[];
  onClose: () => void;
  update: (fn: (l: Layout) => Layout) => void;
  toast: (msg: string, kind?: "ok" | "error") => void;
  onPick: (id: string) => void;
}) {
  const [nn, setNn] = useState("");
  const [extra, setExtra] = useState<string[]>([]);
  const [del, setDel] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const real = groups.filter((g) => items.some((i) => i.group === g) || !Object.values(layout.parents).includes(g));
  const centrals = [...new Set([...Object.values(layout.parents), ...extra])].sort((a, b) => a.localeCompare(b, "ru"));
  const count = (g: string) => items.filter((i) => i.group === g).length;
  const ex = new Set(layout.excluded.groups);
  const hiddenTargets = items.filter((i) => layout.excluded.targets.includes(i.id));
  const toggle = (g: string, on: boolean) => update((l) => {
    l.excluded.groups = on ? l.excluded.groups.filter((x) => x !== g) : [...new Set([...l.excluded.groups, g])];
    return l;
  });
  const remove = async (g: string) => {
    try {
      await api.deleteGroup(g, moveTo || null);
      update((l) => {
        delete l.parents[g];
        l.excluded.groups = l.excluded.groups.filter((x) => x !== g);
        return l;
      });
      toast(moveTo ? `${t("Группа удалена, цели перенесены в")} «${moveTo}»` : t("Группа удалена вместе с целями"));
      setDel(null);
    } catch (e) { toast(String(e), "error"); }
  };
  return (
    <aside className="fm-panel">
      <div className="fm-panel-h">
        <div className="fm-panel-ico"><NodeIcon type="building" variant={1} size={26} /></div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="fm-panel-t">{t("Группы на карте")}</div>
          <div className="c-muted" style={{ fontSize: 12 }}>{t("Что показывать, как объединять, удалить лишнее")}</div>
        </div>
        <button className="btn ghost sm" onClick={onClose}>✕</button>
      </div>

      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Центральные группы")}</div>
        {centrals.map((c) => (
          <div key={c} className="fm-zone-row" style={{ gap: 8 }}>
            <span style={{ flex: 1, cursor: "pointer" }} onClick={() => onPick("zone:" + FAM(c))}>★ {c} <span className="c-muted num" style={{ fontSize: 11 }}>{Object.values(layout.parents).filter((x) => x === c).length}</span></span>
            <button className="btn ghost sm" title={t("Группы останутся, пропадёт только общая рамка")} onClick={() => { update((l) => { for (const g of Object.keys(l.parents)) if (l.parents[g] === c) delete l.parents[g]; delete l.nodes[FAM(c)]; return l; }); setExtra((x) => x.filter((y) => y !== c)); }}>{t("Удалить")}</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <input className="input" placeholder={t("новая центральная группа")} value={nn} onChange={(e) => setNn(e.target.value)} />
          <button className="btn sm" disabled={!nn.trim()} onClick={() => { setExtra((x) => [...x, nn.trim()]); toast(t("Теперь выберите ниже, какие группы в неё входят")); setNn(""); }}>{t("Создать")}</button>
        </div>
      </div>

      <div className="fm-panel-sec">
        <div className="fm-panel-lbl">{t("Группы")} · {t("галочка — показывать на карте")}</div>
        {real.map((g) => (
          <div key={g}>
            <div className="fm-zone-row" style={{ gap: 6 }}>
              <input type="checkbox" checked={!ex.has(g)} onChange={(e) => toggle(g, e.target.checked)} title={t("Показывать на карте")} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer", opacity: ex.has(g) ? 0.5 : 1 }} onClick={() => onPick("zone:G:" + g)}>
                {g} <span className="c-muted num" style={{ fontSize: 11 }}>{count(g)}</span>
              </span>
              <select className="input" style={{ width: 118 }} value={layout.parents[g] ?? ""} onChange={(e) => { const v = e.target.value; update((l) => { if (v) l.parents[g] = v; else delete l.parents[g]; return l; }); }} title={t("Входит в центральную группу")}>
                <option value="">—</option>
                {[...new Set([...centrals, ...real])].filter((x) => x !== g).map((x) => <option key={x} value={x}>{centrals.includes(x) ? "★ " : ""}{x}</option>)}
              </select>
              <button className="btn ghost sm" title={t("Удалить группу")} onClick={() => { setDel(del === g ? null : g); setMoveTo(real.find((x) => x !== g) ?? ""); }}>✕</button>
            </div>
            {del === g && (
              <div style={{ padding: "6px 0 10px 22px" }}>
                <div className="c-muted" style={{ fontSize: 11.5, marginBottom: 6 }}>{t("Куда перенести цели группы")} ({count(g)})</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <select className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                    {real.filter((x) => x !== g).map((x) => <option key={x} value={x}>{x}</option>)}
                    <option value="">{t("никуда — удалить цели")}</option>
                  </select>
                  <button className="btn sm danger" onClick={() => remove(g)}>{t("Удалить")}</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {hiddenTargets.length > 0 && (
        <div className="fm-panel-sec">
          <div className="fm-panel-lbl">{t("Узлы, скрытые с карты")}</div>
          {hiddenTargets.map((i) => (
            <div key={i.id} className="fm-zone-row">
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{i.name} <span className="c-muted" style={{ fontSize: 11 }}>{i.group}</span></span>
              <button className="btn ghost sm" onClick={() => update((l) => { l.excluded.targets = l.excluded.targets.filter((x) => x !== i.id); return l; })}>{t("Вернуть")}</button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
