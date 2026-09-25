import dagre from "@dagrejs/dagre";
import type { MapHop, TargetSummary, Topology } from "../types";
import { guessType, type NodeType } from "./icons";

/**
 * Карта сети: как строится.
 *
 * 1. Из трассировок собирается граф: этот компьютер → хопы → цели. Одинаковые адреса хопов —
 *    один узел. Хоп, чей адрес совпадает с адресом одной из целей, — это и есть эта цель.
 * 2. Цели одной группы — одна рамка (контейнер) с сеткой внутри. Все линии в группу сливаются
 *    в одну: сколько бы целей ни было за хопом, от него к рамке идёт одна ветвь.
 * 3. Хоп, через который путь идёт без развилки, — точка на линии; отдельным узлом остаются
 *    только развилки и слияния путей.
 * 4. Раскладка иерархическая (послойная, как Dagre): слой = удалённость от этого компьютера,
 *    порядок в слоях подбирается так, чтобы линий пересекалось как можно меньше.
 * 5. Центральная группа объединяет несколько групп в общую рамку-площадку.
 * 6. Состояния: обрыв — красным на том участке, где пакеты перестали проходить; всё, что
 *    дальше, — серым пунктиром «недоступно из-за узла выше», а не красным.
 */

/** Что пользователь поменял на карте. Хранится в базе как JSON и переживает обновления. */
export interface NodeCfg {
  /** Закреплённое положение (центр). Для центральной группы — сдвиг. */
  x?: number;
  y?: number;
  type?: NodeType;
  variant?: number;
  label?: string;
  hidden?: boolean;
}

export type Dir = "TB" | "BT" | "LR";

export interface MapOpts {
  /** Бегущие точки по линиям. */
  flow: boolean;
  /** Подписи у всех хопов-точек, а не только у проблемных и при наведении. */
  hopLabels: boolean;
  /** Свернуть транзитные хопы интернета в одно облако. */
  collapseNet: boolean;
  /** Цель с заданным родителем рисуется за ним (а не там, где её поставила трассировка). */
  byDeps: boolean;
  /** Все туннели дугами (иначе только упавшие и у выбранного узла). */
  tunnels: boolean;
  /** Направление: сверху вниз, снизу вверх, слева направо. */
  dir: Dir;
}

export interface Layout {
  v: 3;
  /** Настройки узлов. Ключи: t:<цель>, h:<ip>, G:<группа>, F:<центральная группа>, local. */
  nodes: Record<string, NodeCfg>;
  /** Тип и иконка для всей группы целей. */
  groups: Record<string, { type?: NodeType; variant?: number }>;
  /** Вариант иконки по умолчанию для типа. */
  variants: Partial<Record<NodeType, number>>;
  /** Свёрнутые группы (G:<группа>). */
  collapsed: string[];
  /** Центральная группа: группа → центральная, в которую она входит. */
  parents: Record<string, string>;
  /** Что не показывать на карте вовсе. */
  excluded: { groups: string[]; targets: string[] };
  /** Зафиксированные маршруты, по которым построена схема. Меняются только по кнопке. */
  frozen: { localIp: string | null; routes: Record<string, (string | null)[]> } | null;
  opts: MapOpts;
}

export const EMPTY_LAYOUT: Layout = {
  v: 3,
  nodes: {},
  groups: {},
  variants: {},
  collapsed: [],
  parents: {},
  excluded: { groups: [], targets: [] },
  frozen: null,
  opts: { flow: true, hopLabels: false, collapseNet: false, byDeps: true, tunnels: false, dir: "TB" },
};

export function parseLayout(json: string | null): Layout {
  if (!json) return structuredClone(EMPTY_LAYOUT);
  try {
    const v = JSON.parse(json) as Partial<Layout> & { v?: number; opts?: Partial<MapOpts> };
    const nodes: Record<string, NodeCfg> = {};
    for (const [k, c] of Object.entries(v.nodes ?? {})) {
      // Положения прежних раскладок к новой не подходят — оставляем только подписи и иконки.
      if (v.v !== 3) {
        if (k.startsWith("z:")) continue;
        const { x: _x, y: _y, ...rest } = c;
        if (Object.keys(rest).length) nodes[k] = rest;
      } else nodes[k] = c;
    }
    const o: Partial<MapOpts> = v.opts ?? {};
    return {
      ...structuredClone(EMPTY_LAYOUT),
      nodes,
      groups: v.groups ?? {},
      variants: v.variants ?? {},
      collapsed: v.v === 3 ? (v.collapsed ?? []).filter((k) => k.startsWith("G:")) : [],
      parents: v.parents ?? {},
      excluded: { groups: v.excluded?.groups ?? [], targets: v.excluded?.targets ?? [] },
      frozen: v.frozen ?? null,
      opts: {
        ...EMPTY_LAYOUT.opts,
        flow: o.flow ?? true,
        hopLabels: o.hopLabels ?? false,
        collapseNet: o.collapseNet ?? false,
        byDeps: o.byDeps ?? true,
        tunnels: o.tunnels ?? false,
        dir: o.dir ?? "TB",
      },
    };
  } catch {
    return structuredClone(EMPTY_LAYOUT);
  }
}

/** Состояние для раскраски: одно на узлы, линии и рамки. dep — недоступно из-за узла выше. */
export type St = "ok" | "warn" | "bad" | "down" | "dep" | "idle" | "info";

export const ST_COLOR: Record<St, string> = {
  ok: "#35e08a",
  warn: "#f2c14e",
  bad: "#ff9147",
  down: "#ff4d5e",
  dep: "#6f7885",
  idle: "#5d6671",
  info: "#5aa9ff",
};
const ST_RANK: Record<St, number> = { down: 6, dep: 5, bad: 4, warn: 3, idle: 1, info: 0, ok: 0 };
export const worse = (a: St, b: St) => (ST_RANK[b] > ST_RANK[a] ? b : a);
export const isProblem = (s: St) => s === "down" || s === "dep" || s === "bad" || s === "warn";

export interface GNode {
  key: string;
  /** hop — развилка/слияние путей; zone — свёрнутая группа (карточка). */
  kind: "local" | "hop" | "target" | "net" | "zone";
  label: string;
  sub: string;
  type: NodeType;
  variant: number;
  st: St;
  target?: TargetSummary;
  hop?: MapHop;
  /** Центр иконки. */
  x: number;
  y: number;
  /** Сколько маршрутов через узел проходит и сколько из них сейчас обрываются на нём или раньше. */
  pass: number;
  lost: number;
  /** Положение задано вручную. */
  pinned: boolean;
  /** Рамка группы (G:<группа>), в которой стоит цель, и центральная группа (F:<имя>). */
  site?: string;
  fam?: string;
  /** Для карточки свёрнутой группы: сколько целей и проблем внутри. */
  total?: number;
  bad?: number;
}

/** Промежуточный хоп без развилки — точка на линии. */
export interface Bead {
  key: string;
  ip: string;
  label: string;
  st: St;
  hop?: MapHop;
  pass: number;
  lost: number;
  x: number;
  y: number;
}

export interface GEdge {
  key: string;
  /** Концы: узел (local, h:…, net:…, z:… карточка) или рамка группы G:…. */
  a: string;
  b: string;
  st: St;
  /** pending — маршрут ещё не известен; link — туннель между двумя узлами. */
  kind: "route" | "pending" | "link";
  beads: Bead[];
  /** Состояние каждого отрезка: до первой точки, между точками, от последней до конца. */
  segs: St[];
  /** Сколько маршрутов идёт по линии — толщина. */
  pass: number;
  /** Ломаная раскладки; пусто — рисовать простой кривой между концами. */
  pts: { x: number; y: number }[];
  /** Для туннелей — их имена. */
  names?: string[];
}

export interface Zone {
  key: string;
  /** group — рамка группы; site — центральная группа (площадка). */
  kind: "group" | "site";
  title: string;
  /** Ключ для перетаскивания и выбора: G:<группа> или F:<имя>. */
  site: string;
  x: number;
  y: number;
  w: number;
  h: number;
  st: St;
  total: number;
  bad: number;
  members: string[];
  /** Рамка группы внутри центральной группы — её F:<имя> (двигаются вместе). */
  fam?: string;
  /** Положение задано вручную (линии к ней рисуются напрямую). */
  moved: boolean;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  zones: Zone[];
  byKey: Map<string, GNode>;
  beads: Map<string, Bead>;
  /** Центральные группы: имя → группы. */
  sites: Map<string, string[]>;
  bounds: { x0: number; y0: number; x1: number; y1: number };
  dir: Dir;
}

const TGT = (id: string) => "t:" + id;
const HOP = (ip: string) => "h:" + ip;
export const GRP = (g: string) => "G:" + g;
export const FAM = (f: string) => "F:" + f;
/** Карточка свёрнутой группы. */
export const ZONE = (g: string) => "z:" + g;

function targetSt(h: TargetSummary["health"]): St {
  switch (h) {
    case "ok": return "ok";
    case "warn": return "warn";
    case "bad": return "bad";
    case "crit":
    case "down": return "down";
    case "dependent": return "dep";
    default: return "idle";
  }
}

/** Размеры, px. */
export const CELL_W = 138;
export const CELL_H = 104;
const ICON_Y = 30;
const PAD = 14;
const TITLE_H = 36;
const CARD_W = 236;
const CARD_H = 96;

/** Габариты узлов для раскладки: ширина и расстояние от центра иконки до верха и низа (с подписью). */
export const DIM: Record<GNode["kind"], { w: number; top: number; bottom: number }> = {
  local: { w: 230, top: 32, bottom: 42 },
  target: { w: CELL_W, top: 28, bottom: 64 },
  hop: { w: 124, top: 22, bottom: 46 },
  net: { w: 130, top: 28, bottom: 54 },
  zone: { w: CARD_W, top: CARD_H / 2, bottom: CARD_H / 2 },
};

/** Всё, что считается раскладкой (дорого), кэшируем по «отпечатку» структуры. */
let cache: { sig: string; rects: Map<string, { x: number; y: number; w: number; h: number }>; pts: Map<string, { x: number; y: number }[]> } | null = null;

export function buildGraph(topo: Topology | null, items: TargetSummary[], layout: Layout): Graph {
  const hopInfo = new Map((topo?.hops ?? []).map((h) => [h.ip, h]));
  const routes = new Map((topo?.routes ?? []).map((r) => [r.targetId, r]));
  const cfg = (k: string) => layout.nodes[k] ?? {};
  const dir = layout.opts.dir;
  const exG = new Set(layout.excluded.groups);
  const exT = new Set(layout.excluded.targets);

  const nodes = new Map<string, GNode>();
  const mk = (key: string, n: Partial<GNode> & Pick<GNode, "kind" | "label" | "type">): GNode => {
    let g = nodes.get(key);
    if (!g) {
      const c = cfg(key);
      g = { key, sub: "", variant: 0, st: "idle", x: 0, y: 0, pass: 0, lost: 0, pinned: false, ...n };
      if (c.type) g.type = c.type;
      g.variant = c.variant ?? layout.variants[g.type] ?? 0;
      nodes.set(key, g);
    }
    return g;
  };
  mk("local", { kind: "local", label: "Этот компьютер", sub: topo?.localIp ?? "", type: "pc", st: "info" });

  // ---------------------------------------------------------------- цели
  const active = items.filter((i) => i.enabled && !exG.has(i.group) && !exT.has(i.id));
  for (const s of active) {
    const key = TGT(s.id);
    const g = mk(key, { kind: "target", label: s.name, sub: s.resolvedIp && s.resolvedIp !== s.host ? `${s.host} · ${s.resolvedIp}` : s.host, type: guessType(s.kind, s.name, s.group, s.host), target: s });
    const gr = layout.groups[s.group];
    if (!cfg(key).type && gr?.type) g.type = gr.type;
    if (cfg(key).variant == null) g.variant = gr?.variant ?? layout.variants[g.type] ?? 0;
    g.label = cfg(key).label || s.name;
    g.st = targetSt(s.health);
    g.target = s;
  }
  const byId = new Map(active.map((s) => [s.id, s]));

  // Туннели (GRE и подобные) мониторятся как цели, но по сути это канал между двумя узлами.
  // Концы берём из названия («GRE A - B»): ищем цели с этими словами, лучше маршрутизаторы.
  const TUN_RE = /(^|[\s_\-])(gre|ipsec|l2tp|vxlan|tunnel|туннель)(?=[\s_\-]|$)/gi;
  const isTun = (s: TargetSummary) => new RegExp(TUN_RE.source, "i").test(s.name);
  const words = (v: string) => v.toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const cands = active.filter((s) => !isTun(s)).map((s) => {
    const n = nodes.get(TGT(s.id))!;
    const rank = /(^|[^A-Z])(RTR|ROUTER|EDGE|GW)\d*/i.test(s.name) || n.type === "router" ? 5 : /CORE/i.test(s.name) ? 4 : n.type === "firewall" ? 3 : 0;
    return { key: TGT(s.id), w: words(s.name), rank };
  });
  const resolveEnd = (end: string): string | null => {
    const tw = words(end).filter((x) => x.length >= 2);
    if (!tw.length) return null;
    let best: string | null = null, bestScore = 0, tie = false;
    for (const c of cands) {
      const hit = tw.filter((x) => c.w.some((y) => y === x || (x.length >= 3 && y.startsWith(x)))).length;
      if (!hit) continue;
      const score = hit * 10 + c.rank - c.w.length * 0.1;
      if (score > bestScore) { best = c.key; bestScore = score; tie = false; }
      else if (score === bestScore) tie = true;
    }
    return tie ? null : best;
  };
  const tunnels = new Map<string, { a: string; b: string }>();
  for (const s of active) {
    if (!isTun(s)) continue;
    const body = s.name.replace(TUN_RE, " ").replace(/^[\s_\-]+|[\s_\-]+$/g, "");
    const parts = body.split(/\s*[-–—]\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const a = resolveEnd(parts[0]), b = resolveEnd(parts[parts.length - 1]);
    if (a && b && a !== b) tunnels.set(TGT(s.id), { a, b });
  }

  // ---------------------------------------------------------------- пути
  // Хоп с адресом одной из целей — это она сама.
  const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const ipOf = (s: TargetSummary) => s.resolvedIp || (IPV4.test(s.host) ? s.host : "");
  const ipTarget = new Map<string, string>();
  for (const s of active) {
    const ip = ipOf(s);
    if (ip && !ipTarget.has(ip) && !tunnels.has(TGT(s.id))) ipTarget.set(ip, TGT(s.id));
  }
  // Шлюз отвечает трассировке адресом своего интерфейса в сети компьютера, а цель заведена по
  // другому. Цель, что отвечает сразу на первом хопе и живёт не в сети компьютера, — этот шлюз.
  const firstHop = new Map<string, number>();
  for (const r of routes.values()) {
    const h = r.hops.find(Boolean);
    if (h) firstHop.set(h, (firstHop.get(h) ?? 0) + 1);
  }
  const gwIp = [...firstHop].sort((p, q) => q[1] - p[1])[0]?.[0];
  if (gwIp && !ipTarget.has(gwIp)) {
    const net24 = (ip: string) => ip.split(".").slice(0, 3).join(".");
    const localNet = topo?.localIp ? net24(topo.localIp) : "";
    let best: TargetSummary | null = null, bestScore = -1;
    for (const s of active) {
      const ip = ipOf(s);
      const hs = routes.get(s.id)?.hops.filter(Boolean) ?? [];
      if (!ip || net24(ip) === localNet || hs.length !== 1 || (hs[0] !== ip && hs[0] !== gwIp) || tunnels.has(TGT(s.id))) continue;
      const score = /(CORE|RTR|ROUTER|GW|EDGE)/i.test(s.name) ? 2 : /FW/i.test(s.name) ? 1 : 0;
      if (score > bestScore) { best = s; bestScore = score; }
    }
    if (best) ipTarget.set(gwIp, TGT(best.id));
  }

  // Путь цели — точки: local, хопы/цели на пути, сама цель; для каждой — отвечает ли она сейчас.
  type Pt = { key: string; lost: boolean };
  const paths = new Map<string, Pt[]>();
  for (const s of active) {
    const tk = TGT(s.id);
    if (tunnels.has(tk)) continue;
    const r = routes.get(s.id);
    const down = s.health === "down" || s.health === "dependent";
    if (!r) { paths.set(tk, [{ key: "local", lost: false }, { key: tk, lost: down }]); continue; }
    const reach = r.reach ?? (down ? r.hops.length : null);
    const pts: Pt[] = [{ key: "local", lost: false }];
    let seenPublic = false;
    let inNet: string | null = null;
    r.hops.forEach((ip, idx) => {
      if (!ip) return;
      const lost = reach != null && idx >= reach;
      const hk = HOP(ip);
      if (cfg(hk).hidden) return;
      const info = hopInfo.get(ip);
      const isPublic = info ? !info.private : false;
      if (layout.opts.collapseNet && isPublic && seenPublic) {
        if (!inNet) {
          inNet = "net:" + pts[pts.length - 1].key;
          mk(inNet, { kind: "net", label: "Интернет", type: "cloud", st: "info" });
          pts.push({ key: inNet, lost });
        }
        return;
      }
      inNet = null;
      if (isPublic) seenPublic = true;
      const asT = ipTarget.get(ip);
      if (asT) {
        if (asT !== tk && !pts.some((p) => p.key === asT)) pts.push({ key: asT, lost });
        return;
      }
      const hn = mk(hk, { kind: "hop", label: ip, type: "hop", hop: info });
      hn.hop = info;
      pts.push({ key: hk, lost });
    });
    pts.push({ key: tk, lost: down });
    paths.set(tk, pts);
  }
  // Цель с заданным родителем идёт за ним: родитель + хопы после него.
  if (layout.opts.byDeps) {
    const upTo = (from: string, to: string, depth = 0): boolean => {
      if (from === to || depth > 50) return true;
      const s = byId.get(from.slice(2));
      return !!s?.parentId && upTo(TGT(s.parentId), to, depth + 1);
    };
    for (const s of active) {
      const tk = TGT(s.id), pk = s.parentId ? TGT(s.parentId) : "";
      if (!pk || !paths.has(pk) || !paths.has(tk) || upTo(pk, tk)) continue;
      const own = paths.get(tk)!;
      const i = own.findIndex((p) => p.key === pk);
      const tail = i >= 0 ? own.slice(i + 1) : [own[own.length - 1]];
      paths.set(tk, [{ key: pk, lost: false }, ...tail]);
    }
  }
  // Полный путь от компьютера: для цели за родителем — через путь родителя.
  const fullPath = (tk: string, depth = 0): Pt[] => {
    const p = paths.get(tk)!;
    if (p[0].key === "local" || depth > 50) return p;
    const up = fullPath(p[0].key, depth + 1);
    return [...up.slice(0, -1), { key: p[0].key, lost: up[up.length - 1].lost }, ...p.slice(1)];
  };

  // Счётчики прохода по точкам и отрезкам — для состояния хопов и линий.
  const segAcc = new Map<string, { pass: number; lost: number }>();
  for (const tk of paths.keys()) {
    const p = fullPath(tk);
    for (let i = 1; i < p.length; i++) {
      const n = nodes.get(p[i].key)!;
      if (i < p.length - 1) { n.pass++; if (p[i].lost) n.lost++; }
      const k = p[i - 1].key + ">" + p[i].key;
      const a = segAcc.get(k) ?? { pass: 0, lost: 0 };
      a.pass++;
      if (p[i].lost) a.lost++;
      segAcc.set(k, a);
    }
  }
  // Доступен ли узел сейчас (для «обрыв здесь» против «недоступно из-за узла выше»).
  const alive = (k: string): boolean => {
    if (k === "local") return true;
    const n = nodes.get(k);
    if (!n) return true;
    if (n.kind === "target") return !(n.st === "down" || n.st === "dep");
    return !(n.pass > 0 && n.lost === n.pass);
  };
  const preds = new Map<string, Set<string>>();
  for (const k of segAcc.keys()) {
    const [a, b] = k.split(">");
    if (!preds.has(b)) preds.set(b, new Set());
    preds.get(b)!.add(a);
  }
  // Хоп не отвечает, а всё выше живо — обрыв здесь (красный); выше тоже мёртво — серый.
  for (const n of nodes.values()) {
    if (n.kind !== "hop" && n.kind !== "net") continue;
    if (n.kind === "hop") {
      const ip = n.key.slice(2);
      n.label = cfg(n.key).label || n.hop?.name || ip;
      n.sub = n.label !== ip ? ip : "";
    }
    if (n.pass > 0 && n.lost === n.pass) n.st = [...(preds.get(n.key) ?? [])].some(alive) ? "down" : "dep";
    else if (n.lost > 0) n.st = "warn";
    else if (n.kind === "net") n.st = "info";
    else if (n.hop && (n.hop.rtt != null || (n.hop.loss != null && n.hop.loss < 100))) n.st = n.hop.loss != null && n.hop.loss >= 5 ? "warn" : "ok";
    else n.st = "idle";
  }
  const segSt = (a: string, b: string): St => {
    const s = segAcc.get(a + ">" + b);
    const bn = nodes.get(b)!;
    if (s && s.pass > 0 && s.lost === s.pass) return alive(a) ? "down" : "dep";
    if (s && s.lost > 0) return "warn";
    if (bn.kind === "target") return bn.st === "dep" ? "dep" : bn.st === "idle" ? "idle" : "ok";
    return bn.st === "idle" ? "idle" : bn.st === "dep" ? "dep" : "ok";
  };

  // ---------------------------------------------------------------- группы и центральные группы
  const parentsCfg = layout.parents ?? {};
  const topOf = (g: string) => {
    let cur = g;
    const seen = new Set<string>();
    while (parentsCfg[cur] && parentsCfg[cur] !== cur && !seen.has(cur)) { seen.add(cur); cur = parentsCfg[cur]; }
    return cur;
  };
  const famNames = new Set<string>();
  for (const [g, pg] of Object.entries(parentsCfg)) if (pg && pg !== g) famNames.add(topOf(g));
  const sites = new Map<string, string[]>();
  const collapsed = new Set(layout.collapsed);
  // Элемент раскладки для точки пути: цель → её рамка (или карточка свёрнутой группы).
  const unit = (k: string): string => {
    const n = nodes.get(k);
    if (n?.kind !== "target") return k;
    const g = n.target!.group;
    return collapsed.has(GRP(g)) ? ZONE(g) : GRP(g);
  };
  const members = new Map<string, string[]>();
  for (const k of paths.keys()) {
    const n = nodes.get(k)!;
    const g = n.target!.group;
    if (!members.has(g)) members.set(g, []);
    members.get(g)!.push(k);
    n.site = GRP(g);
    const F = topOf(g);
    if (famNames.has(F)) {
      n.fam = FAM(F);
      if (!sites.has(F)) sites.set(F, []);
      if (!sites.get(F)!.includes(g)) sites.get(F)!.push(g);
    }
  }

  // ---------------------------------------------------------------- граф раскладки
  // Путь в элементах раскладки; возвраты в уже пройденный элемент (петли) вырезаем.
  const unitPaths: { units: string[]; pts: string[][] }[] = [];
  for (const tk of paths.keys()) {
    const p = paths.get(tk)!;
    const units: string[] = [];
    const pts: string[][] = [];
    for (const pt of p) {
      const u = unit(pt.key);
      const at = units.indexOf(u);
      if (at >= 0) {
        units.length = at + 1;
        pts.length = at + 1;
        pts[at].push(pt.key);
        continue;
      }
      units.push(u);
      pts.push([pt.key]);
    }
    unitPaths.push({ units, pts });
  }
  // Развилка или слияние — отдельный узел; хоп без развилки — точка на линии.
  const succ = new Map<string, Set<string>>(), pred = new Map<string, Set<string>>();
  for (const { units } of unitPaths) {
    for (let i = 1; i < units.length; i++) {
      if (!succ.has(units[i - 1])) succ.set(units[i - 1], new Set());
      succ.get(units[i - 1])!.add(units[i]);
      if (!pred.has(units[i])) pred.set(units[i], new Set());
      pred.get(units[i])!.add(units[i - 1]);
    }
  }
  const custom = (k: string) => { const c = cfg(k); return (!!c.type && c.type !== "hop") || !!c.label || c.x != null; };
  const solid = (u: string) => {
    const n = nodes.get(u);
    if (!n || n.kind !== "hop") return true;
    return (succ.get(u)?.size ?? 0) !== 1 || (pred.get(u)?.size ?? 0) !== 1 || custom(u);
  };
  type LE = { a: string; b: string; beads: string[]; pass: number; segs: Set<string>[]; pending: boolean };
  const lEdges = new Map<string, LE>();
  const usedUnits = new Set<string>(["local"]);
  for (const { units, pts } of unitPaths) {
    let start = 0;
    for (let i = 1; i < units.length; i++) {
      if (!solid(units[i])) continue;
      const a = units[start], b = units[i];
      const beadsU = units.slice(start + 1, i);
      const key = a + ">" + b;
      let e = lEdges.get(key);
      if (!e) {
        e = { a, b, beads: beadsU, pass: 0, segs: [...beadsU, b].map(() => new Set<string>()), pending: false };
        lEdges.set(key, e);
      }
      e.pass++;
      // Отрезки на уровне настоящих точек: из последней точки a в первую следующего элемента.
      const chain = [pts[start][pts[start].length - 1], ...beadsU.map((_, j) => pts[start + 1 + j][0]), pts[i][0]];
      if (chain.length - 1 === e.segs.length) chain.slice(1).forEach((to, j) => e!.segs[j].add(chain[j] + ">" + to));
      const last = pts[i][0];
      if (a === "local" && !beadsU.length && nodes.get(last)?.kind === "target" && !routes.has(last.slice(2))) e.pending = true;
      usedUnits.add(a);
      usedUnits.add(b);
      start = i;
    }
  }

  // ---------------------------------------------------------------- размеры
  type Rect = { x: number; y: number; w: number; h: number };
  const boxSize = (g: string) => {
    const n = members.get(g)?.length ?? 0;
    const cols = Math.max(1, Math.min(6, n, Math.ceil(Math.sqrt(n * 1.6))));
    const rows = Math.ceil(n / cols);
    return { cols, rows, w: Math.max(cols * CELL_W + PAD * 2, g.length * 8.5 + 110), h: TITLE_H + rows * CELL_H + 8 };
  };
  const sizeOf = (u: string) => {
    if (u.startsWith("G:")) { const b = boxSize(u.slice(2)); return { w: b.w, h: b.h }; }
    const n = nodes.get(u)!;
    const d = DIM[n.kind];
    return { w: d.w, h: d.top + d.bottom };
  };
  // Карточки свёрнутых групп.
  for (const [g, list] of members) {
    if (!collapsed.has(GRP(g))) continue;
    const card = mk(ZONE(g), { kind: "zone", label: g, type: "building" });
    const tg = list.map((k) => nodes.get(k)!);
    card.total = tg.length;
    card.bad = tg.filter((n) => isProblem(n.st)).length;
    card.st = tg.reduce<St>((acc, n) => worse(acc, n.st === "idle" ? "ok" : n.st), "ok");
    card.site = GRP(g);
    const F = topOf(g);
    if (famNames.has(F)) card.fam = FAM(F);
  }

  // ---------------------------------------------------------------- раскладка (Dagre)
  const unitsList = [...usedUnits].filter((u) => nodes.has(u) || (u.startsWith("G:") && members.has(u.slice(2))));
  const famOfUnit = (u: string) => {
    const g = u.startsWith("G:") || u.startsWith("z:") ? u.slice(2) : null;
    if (!g) return null;
    const F = topOf(g);
    return famNames.has(F) ? F : null;
  };
  const sig = JSON.stringify([
    dir,
    unitsList.map((u) => [u, sizeOf(u).w, sizeOf(u).h, famOfUnit(u)]),
    [...lEdges.values()].map((e) => [e.a, e.b, e.beads.length]),
  ]);
  if (!cache || cache.sig !== sig) {
    const g = new dagre.graphlib.Graph({ compound: true, multigraph: false });
    g.setGraph({ rankdir: dir, nodesep: dir === "LR" ? 64 : 40, ranksep: dir === "LR" ? 110 : 90, edgesep: 18, marginx: 30, marginy: 30, ranker: "network-simplex" });
    g.setDefaultEdgeLabel(() => ({}));
    for (const u of unitsList) {
      const s2 = sizeOf(u);
      g.setNode(u, { width: s2.w, height: s2.h });
    }
    for (const F of famNames) {
      if (!unitsList.some((u) => famOfUnit(u) === F)) continue;
      g.setNode(FAM(F), { paddingTop: TITLE_H + 20, paddingBottom: 20, paddingLeft: 20, paddingRight: 20 });
      for (const u of unitsList) if (famOfUnit(u) === F) g.setParent(u, FAM(F));
    }
    for (const e of lEdges.values()) {
      if (!g.hasNode(e.a) || !g.hasNode(e.b)) continue;
      // Длинной цепочке хопов — больше места, чтобы точки не слиплись.
      g.setEdge(e.a, e.b, { minlen: 1 + Math.floor(e.beads.length / 4), weight: Math.min(10, e.pass) });
    }
    dagre.layout(g);
    const rects = new Map<string, Rect>();
    for (const u of unitsList) {
      const n = g.node(u) as unknown as { x: number; y: number; width: number; height: number };
      rects.set(u, { x: n.x - n.width / 2, y: n.y - n.height / 2, w: n.width, h: n.height });
    }
    const pts = new Map<string, { x: number; y: number }[]>();
    for (const e of lEdges.values()) {
      if (!g.hasEdge(e.a, e.b)) continue;
      const ed = g.edge(e.a, e.b) as unknown as { points?: { x: number; y: number }[] } | undefined;
      if (ed?.points) pts.set(e.a + ">" + e.b, ed.points.map((p) => ({ x: p.x, y: p.y })));
    }
    cache = { sig, rects, pts };
  }
  const { rects } = cache;

  // Закреплённые вручную положения и сдвиги центральных групп.
  const moved = new Set<string>();
  const unitRect = new Map<string, Rect>();
  for (const u of unitsList) {
    const base = rects.get(u);
    if (!base) continue;
    const r = { ...base };
    const c = cfg(u);
    if (c.x != null && c.y != null) { r.x = c.x - r.w / 2; r.y = c.y - r.h / 2; moved.add(u); }
    else {
      const F = famOfUnit(u);
      const off = F ? cfg(FAM(F)) : {};
      if (off.x != null || off.y != null) { r.x += off.x ?? 0; r.y += off.y ?? 0; moved.add(u); }
    }
    unitRect.set(u, r);
  }

  // Узлы: центр иконки внутри своего прямоугольника.
  for (const u of unitsList) {
    const r = unitRect.get(u);
    if (!r || u.startsWith("G:")) continue;
    const n = nodes.get(u)!;
    n.x = r.x + r.w / 2;
    n.y = r.y + DIM[n.kind].top;
    n.pinned = moved.has(u);
  }
  // Цели — сеткой в рамке своей группы.
  const zones: Zone[] = [];
  for (const [g, list] of members) {
    const u = GRP(g);
    const r = unitRect.get(u);
    if (!r) continue;
    const { cols } = boxSize(g);
    const gx = r.x + (r.w - cols * CELL_W) / 2;
    const sorted = [...list].sort((a, b) => nodes.get(a)!.label.localeCompare(nodes.get(b)!.label, "ru"));
    sorted.forEach((k, i) => {
      const n = nodes.get(k)!;
      n.x = gx + (i % cols) * CELL_W + CELL_W / 2;
      n.y = r.y + TITLE_H + Math.floor(i / cols) * CELL_H + ICON_Y;
    });
    const tg = list.map((k) => nodes.get(k)!);
    const st = tg.reduce<St>((acc, n) => worse(acc, n.st === "idle" ? "ok" : n.st), "ok");
    const F = topOf(g);
    zones.push({ key: u, kind: "group", title: g, site: u, ...r, st, total: tg.length, bad: tg.filter((n) => isProblem(n.st)).length, members: sorted, fam: famNames.has(F) ? FAM(F) : undefined, moved: moved.has(u) });
  }
  // Центральные группы — рамка вокруг своих групп.
  for (const F of famNames) {
    const inner = unitsList.filter((u) => famOfUnit(u) === F && unitRect.has(u));
    if (!inner.length) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const u of inner) {
      const r = unitRect.get(u)!;
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    const mem = [...members].filter(([g]) => topOf(g) === F).flatMap(([, l]) => l);
    const tg = mem.map((k) => nodes.get(k)!);
    const st = tg.reduce<St>((acc, n) => worse(acc, n.st === "idle" ? "ok" : n.st), "ok");
    zones.unshift({ key: FAM(F), kind: "site", title: F, site: FAM(F), x: x0 - 20, y: y0 - TITLE_H - 20, w: x1 - x0 + 40, h: y1 - y0 + TITLE_H + 40, st, total: tg.length, bad: tg.filter((n) => isProblem(n.st)).length, members: mem, moved: false });
  }

  // ---------------------------------------------------------------- линии
  const beads = new Map<string, Bead>();
  const edges: GEdge[] = [];
  for (const e of lEdges.values()) {
    if (!unitRect.has(e.a) || !unitRect.has(e.b)) continue;
    // Состояние отрезка — худшее по всем путям, что по нему идут.
    const segs: St[] = e.segs.map((set) => {
      let s: St = "ok";
      for (const sk of set) { const [a, b] = sk.split(">"); s = worse(s, segSt(a, b)); }
      return set.size ? s : "ok";
    });
    const bs: Bead[] = e.beads.map((hk) => {
      const h = nodes.get(hk)!;
      const bead: Bead = { key: hk, ip: hk.startsWith("h:") ? hk.slice(2) : "", label: h.label, st: h.st, hop: h.hop, pass: h.pass, lost: h.lost, x: 0, y: 0 };
      beads.set(hk, bead);
      return bead;
    });
    const fixed = !moved.has(e.a) && !moved.has(e.b);
    edges.push({
      key: e.a + ">" + e.b, a: e.a, b: e.b, st: segs[segs.length - 1], kind: e.pending ? "pending" : "route",
      beads: bs, segs, pass: e.pass, pts: fixed ? cache.pts.get(e.a + ">" + e.b) ?? [] : [],
    });
  }
  // Туннели — дугами между концами (если концы на карте).
  const links = new Map<string, GEdge>();
  for (const [tk, { a, b }] of tunnels) {
    if (!paths.has(a) || !paths.has(b)) continue;
    const key = "l:" + (a < b ? a + "~" + b : b + "~" + a);
    const st0 = nodes.get(tk)!.st;
    const st: St = st0 === "idle" ? "ok" : st0;
    const l = links.get(key);
    if (l) { l.st = worse(l.st, st); l.names!.push(nodes.get(tk)!.label); continue; }
    links.set(key, { key, a, b, st, kind: "link", beads: [], segs: [st], pass: 1, pts: [], names: [nodes.get(tk)!.label] });
  }
  edges.push(...links.values());
  edges.sort((p, q) => ST_RANK[p.st] - ST_RANK[q.st]);

  // ---------------------------------------------------------------- выход
  const visible = [...nodes.values()].filter((n) =>
    n.key === "local" || (n.kind === "target" ? paths.has(n.key) && !collapsed.has(n.site!) : unitRect.has(n.key)),
  );
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of unitRect.values()) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  for (const z of zones) { x0 = Math.min(x0, z.x); y0 = Math.min(y0, z.y - 30); x1 = Math.max(x1, z.x + z.w); y1 = Math.max(y1, z.y + z.h); }
  if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
  return { nodes: visible, edges, zones, byKey: new Map(visible.map((n) => [n.key, n])), beads, sites, bounds: { x0, y0, x1, y1 }, dir };
}

// ---------------------------------------------------------------- геометрия линий

export type P = { x: number; y: number };
export interface Rect { x: number; y: number; w: number; h: number }

/** Прямоугольник узла (с подписью) по центру иконки. */
export const nodeRect = (n: { kind: GNode["kind"]; x: number; y: number }): Rect => {
  const d = DIM[n.kind];
  return { x: n.x - d.w / 2, y: n.y - d.top, w: d.w, h: d.top + d.bottom };
};

/** Откуда из прямоугольника выходит линия и куда входит — по направлению схемы. */
export const outOf = (r: Rect, dir: Dir): P =>
  dir === "LR" ? { x: r.x + r.w, y: r.y + r.h / 2 } : { x: r.x + r.w / 2, y: dir === "TB" ? r.y + r.h : r.y };
export const inOf = (r: Rect, dir: Dir): P =>
  dir === "LR" ? { x: r.x, y: r.y + r.h / 2 } : { x: r.x + r.w / 2, y: dir === "TB" ? r.y : r.y + r.h };

/** Плотная ломаная по гладкой кривой через точки раскладки: между соседними точками —
 *  S-кривая вдоль направления схемы (без петель и выбросов, как у «smooth step»). */
export function smooth(pts: P[], dir: Dir): P[] {
  if (pts.length < 2) return pts;
  const out: P[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) out.push(...cubicPts(pts[i], pts[i + 1], dir, 10).slice(1));
  return out;
}

/** Плавная S-кривая между двумя точками вдоль направления схемы. */
export function cubicPts(a: P, b: P, dir: Dir, steps = 24): P[] {
  const lr = dir === "LR";
  const d = Math.max(steps > 12 ? 40 : 0, Math.abs(lr ? b.x - a.x : b.y - a.y) * 0.5);
  const sg = lr ? Math.sign(b.x - a.x) || 1 : Math.sign(b.y - a.y) || 1;
  const c1 = lr ? { x: a.x + d * sg, y: a.y } : { x: a.x, y: a.y + d * sg };
  const c2 = lr ? { x: b.x - d * sg, y: b.y } : { x: b.x, y: b.y - d * sg };
  const out: P[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return out;
}

/** Делит ломаную на n+1 кусков точками хопов, равномерно по длине (в середине линии). */
export function splitAt(line: P[], n: number): { pieces: P[][]; beads: P[] } {
  if (!n || line.length < 2) return { pieces: [line], beads: [] };
  const len: number[] = [0];
  for (let i = 1; i < line.length; i++) len.push(len[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y));
  const total = len[len.length - 1] || 1;
  const at = (d: number): { p: P; i: number } => {
    let i = 1;
    while (i < len.length - 1 && len[i] < d) i++;
    const f = (d - len[i - 1]) / (len[i] - len[i - 1] || 1);
    return { p: { x: line[i - 1].x + (line[i].x - line[i - 1].x) * f, y: line[i - 1].y + (line[i].y - line[i - 1].y) * f }, i };
  };
  const pieces: P[][] = [];
  const beads: P[] = [];
  let from = 1;
  let cur: P[] = [line[0]];
  for (let k = 1; k <= n; k++) {
    const d = total * (0.12 + (0.76 * k) / (n + 1));
    const { p, i } = at(d);
    for (let j = from; j < i; j++) cur.push(line[j]);
    cur.push(p);
    pieces.push(cur);
    beads.push(p);
    cur = [p];
    from = i;
  }
  for (let j = from; j < line.length; j++) cur.push(line[j]);
  pieces.push(cur);
  return { pieces, beads };
}
