import dagre from "@dagrejs/dagre";
import type { MapHop, ScanResult, TargetSummary, Topology } from "../types";
import { guessType, type NodeType } from "./icons";
import { cv } from "../theme";

/**
 * Карта сети — дерево от этого компьютера.
 *
 * 1. Пути до целей берутся из последнего скана сети (кнопка «Сканировать сеть»); пока скана нет
 *    или цель добавлена после него — из обычной фоновой трассировки.
 * 2. Адреса одного устройства склеиваются в один узел: адрес совпал с целью; шлюз, что отвечает
 *    адресом своего интерфейса; одинаковое имя в DNS; ручная склейка «это один узел».
 * 3. Весь внешний интернет — один узел «Интернет».
 * 4. У каждого узла один родитель — тот, через кого идёт больше всего путей; у цели с заданным
 *    родителем (зависимостью) — он. Получается дерево, линии не расходятся по всей карте.
 * 5. Хоп без развилки — точка на линии; узлом остаются развилки, цели, интернет.
 * 6. Конечные цели одной группы за одним узлом — плитка; к ней идёт одна линия.
 * 7. Состояние: узел, за которым все цели лежат, — обрыв (красный), если выше всё живо;
 *    всё, что дальше, — серое «недоступно из-за узла выше».
 */

/** Что пользователь поменял на карте. Хранится в базе как JSON и переживает обновления. */
export interface NodeCfg {
  /** Закреплённое положение (центр). */
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
  /** Все туннели дугами (иначе только упавшие и у выбранного узла). */
  tunnels: boolean;
  /** Направление: сверху вниз, снизу вверх, слева направо. */
  dir: Dir;
}

export interface Layout {
  v: 4;
  /** Настройки узлов. Ключи: t:<цель>, h:<ip>, T:<плитка>, local, internet. */
  nodes: Record<string, NodeCfg>;
  /** Тип и иконка для всей группы целей. */
  groups: Record<string, { type?: NodeType; variant?: number }>;
  /** Вариант иконки по умолчанию для типа. */
  variants: Partial<Record<NodeType, number>>;
  /** Свёрнутые плитки (T:…). */
  collapsed: string[];
  /** Ручная склейка: адрес хопа → адрес, с которым это одно устройство. */
  aliases: Record<string, string>;
  /** Что не показывать на карте вовсе. */
  excluded: { groups: string[]; targets: string[] };
  opts: MapOpts;
}

export const EMPTY_LAYOUT: Layout = {
  v: 4,
  nodes: {},
  groups: {},
  variants: {},
  collapsed: [],
  aliases: {},
  excluded: { groups: [], targets: [] },
  opts: { flow: true, hopLabels: false, tunnels: false, dir: "TB" },
};

export function parseLayout(json: string | null): Layout {
  if (!json) return structuredClone(EMPTY_LAYOUT);
  try {
    const v = JSON.parse(json) as Partial<Layout> & { v?: number; opts?: Partial<MapOpts> };
    const nodes: Record<string, NodeCfg> = {};
    for (const [k, c] of Object.entries(v.nodes ?? {})) {
      // Положения прежних раскладок к дереву не подходят — оставляем подписи и иконки.
      if (v.v !== 4) {
        if (!k.startsWith("t:") && !k.startsWith("h:")) continue;
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
      collapsed: v.v === 4 ? v.collapsed ?? [] : [],
      aliases: v.aliases ?? {},
      excluded: { groups: v.excluded?.groups ?? [], targets: v.excluded?.targets ?? [] },
      opts: { flow: o.flow ?? true, hopLabels: o.hopLabels ?? false, tunnels: o.tunnels ?? false, dir: o.dir ?? "TB" },
    };
  } catch {
    return structuredClone(EMPTY_LAYOUT);
  }
}

/** Состояние для раскраски: одно на узлы, линии и рамки. dep — недоступно из-за узла выше. */
export type St = "ok" | "warn" | "bad" | "down" | "dep" | "idle" | "info";

/** Цвета состояний берутся из текущей темы. */
export const ST_COLOR: Record<St, string> = {
  get ok() { return cv("--ok"); },
  get warn() { return cv("--warn"); },
  get bad() { return cv("--bad"); },
  get down() { return cv("--down"); },
  get dep() { return cv("--map-dep"); },
  get idle() { return cv("--map-idle"); },
  get info() { return cv("--info"); },
};
const ST_RANK: Record<St, number> = { down: 6, dep: 5, bad: 4, warn: 3, idle: 1, info: 0, ok: 0 };
export const worse = (a: St, b: St) => (ST_RANK[b] > ST_RANK[a] ? b : a);
export const isProblem = (s: St) => s === "down" || s === "dep" || s === "bad" || s === "warn";

export interface GNode {
  key: string;
  /** hop — развилка; net — интернет; zone — карточка (свёрнутая плитка, найденные устройства). */
  kind: "local" | "hop" | "target" | "net" | "zone";
  label: string;
  sub: string;
  type: NodeType;
  variant: number;
  st: St;
  target?: TargetSummary;
  hop?: MapHop;
  /** Все адреса узла (после склейки). */
  ips: string[];
  /** Центр иконки. */
  x: number;
  y: number;
  /** Сколько путей через узел проходит и сколько из них сейчас не доходят до цели. */
  pass: number;
  lost: number;
  pinned: boolean;
  /** Плитка, в которой стоит цель. */
  site?: string;
  fam?: string;
  /** Для карточки: сколько внутри и сколько проблем; для «найдено» — подсеть. */
  total?: number;
  bad?: number;
  subnet?: string;
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
  a: string;
  b: string;
  st: St;
  /** link — туннель между двумя узлами. */
  kind: "route" | "pending" | "link";
  beads: Bead[];
  /** Состояние отрезков: до первой точки, между точками, от последней до конца. */
  segs: St[];
  pass: number;
  /** Ломаная раскладки; пусто — простой кривой между концами. */
  pts: { x: number; y: number }[];
  names?: string[];
}

export interface Zone {
  key: string;
  kind: "group" | "site";
  title: string;
  /** Группа целей плитки. */
  group?: string;
  /** Ключ для перетаскивания и выбора. */
  site: string;
  x: number;
  y: number;
  w: number;
  h: number;
  st: St;
  total: number;
  bad: number;
  members: string[];
  fam?: string;
  moved: boolean;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  zones: Zone[];
  byKey: Map<string, GNode>;
  beads: Map<string, Bead>;
  sites: Map<string, string[]>;
  bounds: { x0: number; y0: number; x1: number; y1: number };
  dir: Dir;
  /** Устройства из скана, которых нет в мониторинге: подсеть → сколько. */
  found: Map<string, number>;
  /** Строилось ли по скану. */
  scanned: boolean;
}

const TGT = (id: string) => "t:" + id;
const HOP = (ip: string) => "h:" + ip;
export const INTERNET = "internet";
export const ZONE = (g: string) => "z:" + g;
export const FAM = (f: string) => "F:" + f;

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
  net: { w: 150, top: 30, bottom: 58 },
  zone: { w: CARD_W, top: CARD_H / 2, bottom: CARD_H / 2 },
};

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
export const isPrivateIp = (ip: string) => {
  const m = ip.match(/^(\d+)\.(\d+)\./);
  if (!m) return ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80");
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b < 128);
};
const net24 = (ip: string) => ip.split(".").slice(0, 3).join(".") + ".0/24";

let cache: { sig: string; rects: Map<string, { x: number; y: number; w: number; h: number }>; pts: Map<string, { x: number; y: number }[]> } | null = null;

export function buildGraph(topo: Topology | null, scan: ScanResult | null, items: TargetSummary[], layout: Layout): Graph {
  const hopInfo = new Map((topo?.hops ?? []).map((h) => [h.ip, h]));
  const liveRoutes = new Map((topo?.routes ?? []).map((r) => [r.targetId, r]));
  const scanRoutes = new Map((scan?.traces ?? []).map((r) => [r.targetId, r]));
  const names: Record<string, string> = { ...(scan?.names ?? {}) };
  for (const h of topo?.hops ?? []) if (h.name) names[h.ip] = h.name;
  const cfg = (k: string) => layout.nodes[k] ?? {};
  const dir = layout.opts.dir;
  const exG = new Set(layout.excluded.groups);
  const exT = new Set(layout.excluded.targets);

  const nodes = new Map<string, GNode>();
  const mk = (key: string, n: Partial<GNode> & Pick<GNode, "kind" | "label" | "type">): GNode => {
    let g = nodes.get(key);
    if (!g) {
      const c = cfg(key);
      g = { key, sub: "", variant: 0, st: "idle", x: 0, y: 0, pass: 0, lost: 0, pinned: false, ips: [], ...n };
      if (c.type) g.type = c.type;
      g.variant = c.variant ?? layout.variants[g.type] ?? 0;
      if (c.label) g.label = c.label;
      nodes.set(key, g);
    }
    return g;
  };
  mk("local", { kind: "local", label: "Этот компьютер", sub: topo?.localIp ?? scan?.localIp ?? "", type: "pc", st: "info" });

  // ---------------------------------------------------------------- цели
  const active = items.filter((i) => i.enabled && !exG.has(i.group) && !exT.has(i.id));
  const devByIp = new Map((scan?.devices ?? []).map((d) => [d.ip, d]));
  const kindType = (k: string | null | undefined): NodeType | null =>
    k && k !== "device" && ["router", "switch", "firewall", "wifi", "server", "hypervisor", "storage", "pc", "phone", "camera", "printer", "ups"].includes(k) ? (k as NodeType) : null;
  const ipOf = (s: TargetSummary) => s.resolvedIp || (IPV4.test(s.host) ? s.host : "");
  for (const s of active) {
    const key = TGT(s.id);
    const g = mk(key, { kind: "target", label: s.name, sub: s.resolvedIp && s.resolvedIp !== s.host ? `${s.host} · ${s.resolvedIp}` : s.host, type: guessType(s.kind, s.name, s.group, s.host), target: s });
    const gr = layout.groups[s.group];
    if (!cfg(key).type && gr?.type) g.type = gr.type;
    // Тип не задан и по имени не угадан — берём, что опознал скан.
    if (!cfg(key).type && !gr?.type && g.type === "device") {
      const kt = kindType(devByIp.get(ipOf(s))?.kind);
      if (kt) g.type = kt;
    }
    if (cfg(key).variant == null) g.variant = gr?.variant ?? layout.variants[g.type] ?? 0;
    g.st = targetSt(s.health);
    g.target = s;
    const ip = ipOf(s);
    if (ip) g.ips.push(ip);
  }

  // Туннели (GRE и подобные) — это канал между двумя узлами; концы — по названию «GRE A - B».
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

  // ---------------------------------------------------------------- склейка адресов
  const ipTarget = new Map<string, string>();
  for (const s of active) {
    const ip = ipOf(s);
    if (ip && !ipTarget.has(ip) && !tunnels.has(TGT(s.id))) ipTarget.set(ip, TGT(s.id));
  }
  const routeOf = (id: string) => scanRoutes.get(id)?.hops ?? liveRoutes.get(id)?.hops ?? null;
  // Шлюз отвечает адресом своего интерфейса в сети компьютера, а цель заведена по другому
  // адресу. Цель, что отвечает сразу на первом хопе и живёт не в сети компьютера, — этот шлюз.
  const firstHop = new Map<string, number>();
  for (const s of active) {
    const h = routeOf(s.id)?.find(Boolean);
    if (h) firstHop.set(h, (firstHop.get(h) ?? 0) + 1);
  }
  const gwIp = scan?.gateway ?? [...firstHop].sort((p, q) => q[1] - p[1])[0]?.[0];
  const localIp = topo?.localIp ?? scan?.localIp ?? "";
  if (gwIp && !ipTarget.has(gwIp)) {
    let best: TargetSummary | null = null, bestScore = -1;
    for (const s of active) {
      const ip = ipOf(s);
      const hs = (routeOf(s.id) ?? []).filter(Boolean);
      if (!ip || net24(ip) === net24(localIp) || hs.length > 1 || (hs.length === 1 && hs[0] !== ip && hs[0] !== gwIp) || tunnels.has(TGT(s.id))) continue;
      const score = /(CORE|RTR|ROUTER|GW|EDGE)/i.test(s.name) ? 2 : /FW/i.test(s.name) ? 1 : 0;
      if (score > bestScore) { best = s; bestScore = score; }
    }
    if (best) ipTarget.set(gwIp, TGT(best.id));
  }
  // Одинаковое имя в DNS — одно устройство.
  const byName = new Map<string, string>();
  const aliasOf = (ip: string): string => {
    let cur = ip;
    for (let i = 0; i < 10 && layout.aliases[cur] && layout.aliases[cur] !== cur; i++) cur = layout.aliases[cur];
    return cur;
  };
  const canon = (ip0: string): string => {
    const ip = aliasOf(ip0);
    const t = ipTarget.get(ip);
    if (t) return t;
    const nm = names[ip];
    if (nm) {
      const first = byName.get(nm);
      if (first && first !== ip) return HOP(first);
      if (!first) byName.set(nm, ip);
    }
    return HOP(ip);
  };

  // ---------------------------------------------------------------- пути
  type Pt = { key: string };
  const paths = new Map<string, Pt[]>();
  for (const s of active) {
    const tk = TGT(s.id);
    if (tunnels.has(tk)) continue;
    const hops = routeOf(s.id);
    const pts: Pt[] = [{ key: "local" }];
    if (hops) {
      for (const ip of hops) {
        if (!ip) continue;
        if (cfg(HOP(ip)).hidden) continue;
        let key: string;
        if (!isPrivateIp(ip) && !ipTarget.has(aliasOf(ip)) && !layout.aliases[ip]) key = INTERNET;
        else key = canon(ip);
        if (key === tk) continue;
        if (pts[pts.length - 1].key === key) continue;
        // Петля (узел уже был на пути) — срезаем обход.
        const at = pts.findIndex((p) => p.key === key);
        if (at >= 0) { pts.length = at + 1; continue; }
        if (key.startsWith("h:")) {
          const hip = key.slice(2);
          const n = mk(key, { kind: "hop", label: hip, type: "hop", hop: hopInfo.get(hip) });
          if (n.type === "hop" && !cfg(key).type) {
            const kt = kindType(devByIp.get(hip)?.kind);
            if (kt && kt !== "pc") n.type = kt;
          }
          if (!n.ips.includes(ip)) n.ips.push(ip);
          n.hop = n.hop ?? hopInfo.get(ip);
        } else if (key === INTERNET) {
          mk(INTERNET, { kind: "net", label: "Интернет", type: "cloud", st: "ok" });
        } else {
          const n = nodes.get(key)!;
          if (!n.ips.includes(ip)) n.ips.push(ip);
        }
        pts.push({ key });
      }
    } else if (!isPrivateIp(ipOf(s) || "10.0.0.0") && ipOf(s)) {
      // Маршрута ещё нет, адрес внешний — всё равно через интернет.
      mk(INTERNET, { kind: "net", label: "Интернет", type: "cloud", st: "ok" });
      pts.push({ key: INTERNET });
    }
    pts.push({ key: tk });
    paths.set(tk, pts);
  }
  // Цель с заданным родителем идёт за ним.
  const parentTarget = new Map<string, string>();
  for (const s of active) {
    const tk = TGT(s.id), pk = s.parentId ? TGT(s.parentId) : "";
    if (!pk || pk === tk || !paths.has(pk) || !paths.has(tk)) continue;
    let cur: string | undefined = pk, loop = false;
    for (let i = 0; i < 50 && cur; i++) {
      if (cur === tk) { loop = true; break; }
      cur = parentTarget.get(cur);
    }
    if (!loop) parentTarget.set(tk, pk);
  }

  // Подписи хопов.
  for (const n of nodes.values()) {
    if (n.kind !== "hop") continue;
    const ip = n.key.slice(2);
    n.label = cfg(n.key).label || names[ip] || ip;
    n.sub = n.label !== ip ? ip : "";
    if (n.ips.length > 1) n.sub = n.ips.join(", ");
  }
  const inet = nodes.get(INTERNET);
  if (inet) {
    // Кто провайдер — по имени первого внешнего хопа.
    const orgs = new Map<string, number>();
    for (const s of active) {
      const hops = routeOf(s.id) ?? [];
      const first = hops.find((h) => h && !isPrivateIp(h));
      const nm = first ? names[first] : undefined;
      const org = nm?.split(".").slice(-2).join(".");
      if (org) orgs.set(org, (orgs.get(org) ?? 0) + 1);
    }
    inet.sub = [...orgs].sort((p, q) => q[1] - p[1]).slice(0, 2).map((x) => x[0]).join(" · ");
    inet.label = cfg(INTERNET).label || "Интернет";
  }

  // ---------------------------------------------------------------- дерево
  const passAB = new Map<string, number>();
  for (const [tk, p] of paths) {
    const pk = parentTarget.get(tk);
    let pts = p;
    if (pk) {
      const i = p.findIndex((x) => x.key === pk);
      pts = [{ key: pk }, ...(i >= 0 ? p.slice(i + 1) : [p[p.length - 1]])];
      paths.set(tk, pts);
    }
    for (let i = 1; i < pts.length; i++) {
      const k = pts[i - 1].key + ">" + pts[i].key;
      passAB.set(k, (passAB.get(k) ?? 0) + 1);
    }
  }
  const parent = new Map<string, string>();
  const best = new Map<string, number>();
  for (const [k, n] of passAB) {
    const [a, b] = k.split(">");
    if (parentTarget.has(b)) continue;
    if ((best.get(b) ?? -1) < n) { parent.set(b, a); best.set(b, n); }
  }
  for (const [tk, pk] of parentTarget) parent.set(tk, pk);
  for (const k of [...parent.keys()]) {
    const seen = new Set([k]);
    let cur = parent.get(k);
    while (cur && cur !== "local") {
      if (seen.has(cur)) { parent.set(k, "local"); break; }
      seen.add(cur);
      cur = parent.get(cur);
    }
  }
  const kids = new Map<string, string[]>();
  for (const [k, p] of parent) {
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(k);
  }

  // ---------------------------------------------------------------- состояние
  // Живо ли всё за узлом: если хоть одна цель за ним отвечает — узел жив.
  const below = new Map<string, { up: number; all: number }>();
  const walk = (k: string): { up: number; all: number } => {
    const n = nodes.get(k)!;
    const acc = { up: 0, all: 0 };
    if (n.kind === "target") { acc.all++; if (!(n.st === "down" || n.st === "dep")) acc.up++; }
    for (const c of kids.get(k) ?? []) { const r = walk(c); acc.up += r.up; acc.all += r.all; }
    below.set(k, acc);
    return acc;
  };
  walk("local");
  const alive = (k: string) => {
    const n = nodes.get(k);
    if (!n || k === "local") return true;
    if (n.kind === "target") return !(n.st === "down" || n.st === "dep");
    const b = below.get(k);
    return !b || b.all === 0 || b.up > 0;
  };
  for (const n of nodes.values()) {
    if (n.kind !== "hop" && n.kind !== "net") continue;
    const b = below.get(n.key) ?? { up: 0, all: 0 };
    n.pass = b.all;
    n.lost = b.all - b.up;
    if (b.all > 0 && b.up === 0) n.st = alive(parent.get(n.key) ?? "local") ? "down" : "dep";
    else if (b.up < b.all) n.st = "warn";
    else if (n.kind === "net") n.st = "ok";
    else if (n.hop?.loss != null && n.hop.loss >= 20 && b.all) n.st = "warn";
    else n.st = b.all ? "ok" : "idle";
  }
  const segSt = (a: string, b: string): St => {
    const bn = nodes.get(b)!;
    if (!alive(b)) return alive(a) ? "down" : "dep";
    if (bn.kind === "target") return bn.st === "idle" ? "idle" : bn.st === "ok" ? "ok" : bn.st;
    return bn.st === "warn" ? "warn" : "ok";
  };

  // ---------------------------------------------------------------- что рисовать узлом
  const custom = (k: string) => { const c = cfg(k); return (!!c.type && c.type !== "hop") || !!c.label || c.x != null; };
  const solid = (k: string) => {
    const n = nodes.get(k)!;
    if (n.kind !== "hop") return true;
    return (kids.get(k)?.length ?? 0) !== 1 || custom(k);
  };
  // Видимый родитель и цепочка точек до него.
  const vparent = new Map<string, string>();
  const beadKeys = new Map<string, string[]>();
  for (const k of parent.keys()) {
    if (!solid(k)) continue;
    let p = parent.get(k)!;
    const chain: string[] = [];
    while (p !== "local" && !solid(p)) { chain.unshift(p); p = parent.get(p) ?? "local"; }
    vparent.set(k, p);
    beadKeys.set(k, chain);
  }
  const vkids = new Map<string, string[]>();
  for (const [k, p] of vparent) {
    if (!vkids.has(p)) vkids.set(p, []);
    vkids.get(p)!.push(k);
  }

  // ---------------------------------------------------------------- плитки и карточки
  const collapsed = new Set(layout.collapsed);
  // Элемент раскладки: узел, плитка T:<родитель>|<группа> или карточка.
  const unitOf = new Map<string, string>();
  const tiles = new Map<string, { parent: string; group: string; members: string[] }>();
  for (const [p, list] of vkids) {
    const byGroup = new Map<string, string[]>();
    for (const c of list) {
      const n = nodes.get(c)!;
      if (n.kind === "target" && !vkids.has(c) && !(beadKeys.get(c)?.length)) {
        const g = n.target!.group;
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g)!.push(c);
      }
    }
    for (const [g, mem] of byGroup) {
      if (mem.length < 2) continue;
      const tk = "T:" + p + "|" + g;
      tiles.set(tk, { parent: p, group: g, members: mem });
      for (const m of mem) { unitOf.set(m, tk); nodes.get(m)!.site = tk; }
    }
  }
  for (const [tk, t] of tiles) {
    if (!collapsed.has(tk)) continue;
    const card = mk(ZONE(tk), { kind: "zone", label: t.group, type: "building" });
    const tg = t.members.map((k) => nodes.get(k)!);
    card.total = tg.length;
    card.bad = tg.filter((n) => isProblem(n.st)).length;
    card.st = tg.reduce<St>((acc, n) => worse(acc, n.st === "idle" ? "ok" : n.st), "ok");
    card.site = tk;
  }
  const unit = (k: string) => {
    const t = unitOf.get(k);
    if (!t) return k;
    return collapsed.has(t) ? ZONE(t) : t;
  };
  // Найденные сканом устройства, которых нет в мониторинге, — карточка на подсеть у шлюза.
  // Сравниваем со всеми целями (и выключенными, и скрытыми): они уже заведены.
  const monitoredIps = new Set(items.flatMap((s) => [s.host, s.resolvedIp ?? ""]).filter(Boolean));
  const found = new Map<string, number>();
  for (const d of scan?.devices ?? []) {
    if (d.targetId || monitoredIps.has(d.ip)) continue;
    found.set(d.subnet, (found.get(d.subnet) ?? 0) + 1);
  }
  const foundParent = (subnet: string): string => {
    // Узел из этой подсети на карте (обычно её маршрутизатор) — иначе шлюз компьютера, иначе компьютер.
    const inNet = [...vparent.keys()].find((k) => (nodes.get(k)?.ips ?? []).some((ip) => net24(ip) === subnet) && (vkids.get(k)?.length ?? 0) > 0);
    if (inNet) return inNet;
    const gw = gwIp ? (ipTarget.get(gwIp) ?? HOP(gwIp)) : null;
    if (gw && vparent.has(gw) && net24(localIp) === subnet) return gw;
    return "local";
  };
  for (const [subnet, n] of found) {
    const key = "found:" + subnet;
    const card = mk(key, { kind: "zone", label: "Не в мониторинге", type: "device", st: "idle" });
    card.sub = subnet;
    card.subnet = subnet;
    card.total = n;
    card.bad = 0;
    vparent.set(key, foundParent(subnet));
    beadKeys.set(key, []);
  }

  // ---------------------------------------------------------------- граф раскладки
  type LE = { a: string; b: string; beads: string[]; pass: number; segs: St[] };
  const lEdges = new Map<string, LE>();
  for (const [k, p] of vparent) {
    const a = unit(p), b = unit(k);
    if (a === b) continue;
    const key = a + ">" + b;
    const chain = beadKeys.get(k) ?? [];
    const isTile = b !== k;
    const pts = [p, ...chain, k];
    const segs: St[] = k.startsWith("found:") ? ["idle"] : pts.slice(1).map((x, i) => segSt(pts[i], x));
    const e = lEdges.get(key);
    if (e) {
      e.pass += below.get(k)?.all ?? 1;
      e.segs = e.segs.map((s, i) => worse(s, segs[i] ?? s));
      continue;
    }
    lEdges.set(key, { a, b, beads: isTile ? [] : chain, pass: below.get(k)?.all ?? 1, segs: isTile ? [segs[segs.length - 1]] : segs });
  }
  // В плитку — худшее из состояний её целей.
  for (const e of lEdges.values()) {
    if (!e.b.startsWith("T:")) continue;
    const t = tiles.get(e.b)!;
    const all = t.members.every((m) => !alive(m));
    const any = t.members.some((m) => !alive(m));
    e.segs = [all ? (alive(t.parent) ? "down" : "dep") : any ? "warn" : "ok"];
  }

  const boxSize = (n: number, title: string) => {
    const cols = Math.max(1, Math.min(6, n, Math.ceil(Math.sqrt(n * 1.6))));
    const rows = Math.ceil(n / cols);
    return { cols, rows, w: Math.max(cols * CELL_W + PAD * 2, title.length * 8.5 + 110), h: TITLE_H + rows * CELL_H + 8 };
  };
  const units = new Set<string>(["local"]);
  for (const e of lEdges.values()) { units.add(e.a); units.add(e.b); }
  const sizeOf = (u: string) => {
    if (u.startsWith("T:")) { const t = tiles.get(u)!; const b = boxSize(t.members.length, t.group); return { w: b.w, h: b.h }; }
    const d = DIM[nodes.get(u)!.kind];
    return { w: d.w, h: d.top + d.bottom };
  };
  const unitsList = [...units].filter((u) => nodes.has(u) || tiles.has(u));
  const sig = JSON.stringify([dir, unitsList.map((u) => [u, sizeOf(u).w, sizeOf(u).h]), [...lEdges.values()].map((e) => [e.a, e.b, e.beads.length])]);
  if (!cache || cache.sig !== sig) {
    const g = new dagre.graphlib.Graph({ multigraph: false });
    g.setGraph({ rankdir: dir, nodesep: dir === "LR" ? 60 : 40, ranksep: dir === "LR" ? 110 : 90, edgesep: 18, marginx: 30, marginy: 30, ranker: "tight-tree" });
    g.setDefaultEdgeLabel(() => ({}));
    for (const u of unitsList) { const s2 = sizeOf(u); g.setNode(u, { width: s2.w, height: s2.h }); }
    for (const e of lEdges.values()) {
      if (!g.hasNode(e.a) || !g.hasNode(e.b)) continue;
      g.setEdge(e.a, e.b, { minlen: 1 + Math.floor(e.beads.length / 4), weight: Math.min(10, e.pass) });
    }
    dagre.layout(g);
    const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
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
  const moved = new Set<string>();
  const unitRect = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const u of unitsList) {
    const base = cache.rects.get(u);
    if (!base) continue;
    const r = { ...base };
    const c = cfg(u);
    if (c.x != null && c.y != null) { r.x = c.x - r.w / 2; r.y = c.y - r.h / 2; moved.add(u); }
    unitRect.set(u, r);
  }
  for (const u of unitsList) {
    const r = unitRect.get(u);
    if (!r || u.startsWith("T:")) continue;
    const n = nodes.get(u)!;
    n.x = r.x + r.w / 2;
    n.y = r.y + DIM[n.kind].top;
    n.pinned = moved.has(u);
  }
  const zones: Zone[] = [];
  for (const [tk, t] of tiles) {
    const r = unitRect.get(tk);
    if (!r) continue;
    const { cols } = boxSize(t.members.length, t.group);
    const gx = r.x + (r.w - cols * CELL_W) / 2;
    const sorted = [...t.members].sort((a, b) => nodes.get(a)!.label.localeCompare(nodes.get(b)!.label, "ru"));
    sorted.forEach((k, i) => {
      const n = nodes.get(k)!;
      n.x = gx + (i % cols) * CELL_W + CELL_W / 2;
      n.y = r.y + TITLE_H + Math.floor(i / cols) * CELL_H + ICON_Y;
    });
    const tg = sorted.map((k) => nodes.get(k)!);
    const st = tg.reduce<St>((acc, n) => worse(acc, n.st === "idle" ? "ok" : n.st), "ok");
    zones.push({ key: tk, kind: "group", title: t.group, group: t.group, site: tk, ...r, st, total: tg.length, bad: tg.filter((n) => isProblem(n.st)).length, members: sorted, moved: moved.has(tk) });
  }

  // ---------------------------------------------------------------- линии
  const beads = new Map<string, Bead>();
  const edges: GEdge[] = [];
  for (const e of lEdges.values()) {
    if (!unitRect.has(e.a) || !unitRect.has(e.b)) continue;
    const bs: Bead[] = e.beads.map((hk) => {
      const h = nodes.get(hk)!;
      const bead: Bead = { key: hk, ip: h.ips.join(", ") || hk.slice(2), label: h.label, st: h.st, hop: h.hop, pass: h.pass, lost: h.lost, x: 0, y: 0 };
      beads.set(hk, bead);
      return bead;
    });
    const fixed = !moved.has(e.a) && !moved.has(e.b);
    const pending = e.a === "local" && e.b.startsWith("t:") && !routeOf(e.b.slice(2));
    edges.push({ key: e.a + ">" + e.b, a: e.a, b: e.b, st: e.segs[e.segs.length - 1], kind: pending ? "pending" : "route", beads: bs, segs: e.segs, pass: e.pass, pts: fixed ? cache.pts.get(e.a + ">" + e.b) ?? [] : [] });
  }
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

  const visible = [...nodes.values()].filter((n) =>
    n.key === "local" || (n.kind === "target" ? paths.has(n.key) && !collapsed.has(n.site ?? "") && (unitRect.has(n.key) || !!n.site) : unitRect.has(n.key)),
  );
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of unitRect.values()) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y - 30); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
  return { nodes: visible, edges, zones, byKey: new Map(visible.map((n) => [n.key, n])), beads, sites: new Map(), bounds: { x0, y0, x1, y1 }, dir, found, scanned: !!scan };
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
