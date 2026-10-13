/**
 * Темы оформления. Тема — это набор переменных CSS (цвета, шрифты, скругления),
 * раскладка навигации (боковая панель или меню сверху) и атрибут data-theme на <html>,
 * по которому themes.css дорисовывает то, что не выражается переменными.
 *
 * Смысл цветов состояния одинаков во всех темах: зелёный — норма, жёлтый — внимание,
 * оранжевый — плохо, красный — авария. Тема меняет только оттенки, чтобы они читались на её фоне.
 */

export type ThemeId = "pulse" | "graphite" | "glass";
export type NavLayout = "side" | "top";

export interface ThemeDef {
  id: ThemeId;
  name: string;
  desc: string;
  layout: NavLayout;
  dark: boolean;
  /** Цвета для превью в настройках: фон, карточка, акцент, второй акцент, текст. */
  swatch: [string, string, string, string, string];
  vars: Record<string, string>;
}

const rgb = (hex: string) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

/** Цвета состояний и производные от них переменные. */
function status(c: { ok: string; warn: string; bad: string; down: string; info: string; route: string; dep: string }) {
  return {
    "--ok": c.ok, "--warn": c.warn, "--bad": c.bad, "--down": c.down, "--info": c.info, "--route": c.route,
    "--ok-rgb": rgb(c.ok), "--warn-rgb": rgb(c.warn), "--bad-rgb": rgb(c.bad), "--down-rgb": rgb(c.down),
    "--info-rgb": rgb(c.info), "--route-rgb": rgb(c.route), "--dep": c.dep, "--dep-rgb": rgb(c.dep),
  };
}

const MONO = '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Cascadia Mono", monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", Inter, Roboto, sans-serif';

/** Нынешняя тема — от неё остальные берут всё, что не переопределяют. */
const PULSE: Record<string, string> = {
  "--page-bg": "#000000",
  "--bg": "#000000",
  "--bg-1": "#07090b",
  "--bg-2": "#0d1014",
  "--bg-3": "#141920",
  "--surface": "#07090b",
  "--surface-border": "#1b2128",
  "--sticky-bg": "#000000",
  "--line": "#1b2128",
  "--line-2": "#27303a",
  "--line-3": "#34404c",
  "--text": "#e8ecf1",
  "--text-2": "#aab3be",
  "--muted": "#6c7682",
  "--dim": "#3f4750",
  "--paused": "#5c6570",
  "--accent": "#35e08a",
  "--accent-2": "#1fb36b",
  "--accent-rgb": rgb("#35e08a"),
  "--accent-hover": "#4bf09b",
  "--accent-soft": "#0c1712",
  "--on-accent": "#03140a",
  "--on-solid": "#ffffff",
  "--menu-hover": "#1fb36b",
  "--menu-hover-fg": "#ffffff",
  "--nav-active-bg": "#141920",
  "--nav-active-fg": "#e8ecf1",
  "--knob": "#cfd6de",
  "--knob-on": "#ffffff",
  "--fg-rgb": "255, 255, 255",
  "--shadow-rgb": "0, 0, 0",
  "--shadow-k": "1",
  "--scrim": "rgba(0, 0, 0, 0.72)",
  "--overlay": "rgba(13, 16, 20, 0.97)",
  "--overlay-soft": "rgba(7, 9, 11, 0.82)",
  "--scroll": "#1d242c",
  "--blur": "none",
  "--down-text": "#ffc2c8",
  "--dep-dot": "#8a6f73",
  "--dep-strong": "#992b37",
  ...status({ ok: "#35e08a", warn: "#f2c14e", bad: "#ff9147", down: "#ff4d5e", info: "#5aa9ff", route: "#b48cff", dep: "#c9a3a8" }),
  "--zone-ok": "rgba(53, 224, 138, 0.075)",
  "--zone-warn": "rgba(242, 193, 78, 0.09)",
  "--zone-orange": "rgba(255, 145, 71, 0.1)",
  "--zone-bad": "rgba(255, 77, 94, 0.11)",
  "--chart-line": "#35e08a",
  "--chart-under": "rgba(8, 11, 14, 0.55)",
  "--chart-axis": "#6c7682",
  "--chart-frame": "#1b2128",
  "--map-bg": "radial-gradient(1200px 700px at 30% 40%, rgba(53, 224, 138, 0.045), transparent 70%), #05070a",
  "--map-grid": "rgba(255, 255, 255, 0.05)",
  "--map-tile": "#0b0f13",
  "--map-tile-hover": "#10161b",
  "--map-label": "#e9eef3",
  "--map-sub": "#8b95a1",
  "--map-hop": "#aab3be",
  "--map-hub": "#c9d2dc",
  "--map-halo": "#05070a",
  "--map-chip": "#070a0d",
  "--map-dep": "#6f7885",
  "--map-idle": "#5d6671",
  "--r-ctl": "8px",
  "--r-card": "12px",
  "--r-card-lg": "16px",
  "--r-pop": "10px",
  "--radius": "10px",
  "--sans": SANS,
  "--mono": MONO,
  "--num": MONO,
  "--title-weight": "600",
};

/** Графит: тёмно-серый, крупные скруглённые карточки, коралловый и янтарный акценты. */
const GRAPHITE: Record<string, string> = {
  "--page-bg": "#1d1f24",
  "--bg": "#1d1f24",
  "--bg-1": "#26292f",
  "--bg-2": "#2d3037",
  "--bg-3": "#363a42",
  "--surface": "#26292f",
  "--surface-border": "transparent",
  "--sticky-bg": "#1d1f24",
  "--line": "#33363d",
  "--line-2": "#40444d",
  "--line-3": "#4d525c",
  "--text": "#f5f6f8",
  "--text-2": "#b9bdc6",
  "--muted": "#878c96",
  "--dim": "#555a63",
  "--paused": "#6a6f78",
  "--accent": "#ff5a4f",
  "--accent-2": "#ff5a4f",
  "--accent-rgb": rgb("#ff5a4f"),
  "--accent-hover": "#ff7166",
  "--accent-soft": "rgba(255, 90, 79, 0.12)",
  "--on-accent": "#ffffff",
  "--menu-hover": "#ff5a4f",
  "--nav-active-bg": "transparent",
  "--nav-active-fg": "#ff5a4f",
  "--knob": "#d7dae0",
  "--overlay": "rgba(38, 41, 47, 0.98)",
  "--overlay-soft": "rgba(29, 31, 36, 0.86)",
  "--scroll": "#3a3e46",
  "--down-text": "#ffc9cf",
  ...status({ ok: "#3fd58a", warn: "#ffbe2e", bad: "#ff8d3a", down: "#ff3b5c", info: "#62a8ff", route: "#b993ff", dep: "#c9a3a8" }),
  "--zone-ok": "rgba(63, 213, 138, 0.06)",
  "--zone-warn": "rgba(255, 190, 46, 0.08)",
  "--zone-orange": "rgba(255, 141, 58, 0.09)",
  "--zone-bad": "rgba(255, 59, 92, 0.1)",
  "--chart-line": "#ffbe2e",
  "--chart-under": "rgba(29, 31, 36, 0.6)",
  "--chart-axis": "#878c96",
  "--chart-frame": "#33363d",
  "--map-bg": "radial-gradient(1200px 700px at 30% 40%, rgba(255, 90, 79, 0.05), transparent 70%), #1d1f24",
  "--map-grid": "rgba(255, 255, 255, 0.06)",
  "--map-tile": "#2a2d34",
  "--map-tile-hover": "#33363e",
  "--map-label": "#f5f6f8",
  "--map-sub": "#9a9fa8",
  "--map-hop": "#b9bdc6",
  "--map-hub": "#d3d6dc",
  "--map-halo": "#1d1f24",
  "--map-chip": "#26292f",
  "--map-dep": "#6f747d",
  "--map-idle": "#5f646c",
  "--r-ctl": "10px",
  "--r-card": "18px",
  "--r-card-lg": "22px",
  "--r-pop": "14px",
  "--radius": "18px",
  "--num": SANS,
  "--title-weight": "700",
};

/** Стекло: тёмный тёплый фон с размытыми пятнами, полупрозрачные карточки, оранжевый акцент. */
const GLASS: Record<string, string> = {
  "--page-bg": "radial-gradient(900px 700px at 92% 100%, rgba(255, 110, 30, 0.42), transparent 60%), radial-gradient(800px 600px at 8% 10%, rgba(40, 130, 150, 0.28), transparent 60%), radial-gradient(900px 700px at 55% 45%, rgba(110, 70, 45, 0.45), transparent 70%), #16120f",
  "--bg": "#16120f",
  "--bg-1": "rgba(255, 255, 255, 0.055)",
  "--bg-2": "rgba(255, 255, 255, 0.08)",
  "--bg-3": "rgba(255, 255, 255, 0.12)",
  "--surface": "rgba(255, 255, 255, 0.055)",
  "--surface-border": "rgba(255, 255, 255, 0.12)",
  "--sticky-bg": "rgba(30, 24, 20, 0.72)",
  "--line": "rgba(255, 255, 255, 0.09)",
  "--line-2": "rgba(255, 255, 255, 0.15)",
  "--line-3": "rgba(255, 255, 255, 0.26)",
  "--text": "#f6f1ec",
  "--text-2": "#cfc5bc",
  "--muted": "#9c9188",
  "--dim": "#62584f",
  "--paused": "#7c7168",
  "--accent": "#ff7a1f",
  "--accent-2": "#ff7a1f",
  "--accent-rgb": rgb("#ff7a1f"),
  "--accent-hover": "#ff8d3d",
  "--accent-soft": "rgba(255, 122, 31, 0.16)",
  "--on-accent": "#ffffff",
  "--menu-hover": "#ff7a1f",
  "--nav-active-bg": "#ff7a1f",
  "--nav-active-fg": "#ffffff",
  "--knob": "#e8e0d8",
  "--overlay": "rgba(36, 29, 24, 0.94)",
  "--overlay-soft": "rgba(30, 24, 20, 0.7)",
  "--scroll": "rgba(255, 255, 255, 0.16)",
  "--blur": "blur(22px) saturate(140%)",
  "--down-text": "#ffc9cf",
  ...status({ ok: "#43dc98", warn: "#f7cb4a", bad: "#ffab4d", down: "#ff4d6a", info: "#6db9ff", route: "#c49bff", dep: "#cfa7ac" }),
  "--zone-ok": "rgba(67, 220, 152, 0.06)",
  "--zone-warn": "rgba(247, 203, 74, 0.08)",
  "--zone-orange": "rgba(255, 171, 77, 0.09)",
  "--zone-bad": "rgba(255, 77, 106, 0.1)",
  "--chart-line": "#f6f1ec",
  "--chart-under": "rgba(22, 18, 15, 0.5)",
  "--chart-axis": "#9c9188",
  "--chart-frame": "rgba(255, 255, 255, 0.09)",
  "--map-bg": "transparent",
  "--map-grid": "rgba(255, 255, 255, 0.07)",
  "--map-tile": "#2a221d",
  "--map-tile-hover": "#352a23",
  "--map-label": "#f6f1ec",
  "--map-sub": "#a89d94",
  "--map-hop": "#cfc5bc",
  "--map-hub": "#e2d9d0",
  "--map-halo": "#1d1713",
  "--map-chip": "#241d18",
  "--map-dep": "#7d7269",
  "--map-idle": "#6b6058",
  "--r-ctl": "10px",
  "--r-card": "16px",
  "--r-card-lg": "20px",
  "--r-pop": "14px",
  "--radius": "16px",
};

export const THEMES: ThemeDef[] = [
  { id: "pulse", name: "NetPulse", desc: "Основная: чёрный фон, зелёный акцент, боковое меню", layout: "side", dark: true, swatch: ["#000000", "#0d1014", "#35e08a", "#5aa9ff", "#e8ecf1"], vars: PULSE },
  { id: "graphite", name: "Графит", desc: "Тёмно-серая, крупные карточки, коралловый и янтарный акценты, меню сверху", layout: "top", dark: true, swatch: ["#1d1f24", "#2d3037", "#ff5a4f", "#ffbe2e", "#f5f6f8"], vars: { ...PULSE, ...GRAPHITE } },
  { id: "glass", name: "Стекло", desc: "Полупрозрачные панели на тёплом размытом фоне, оранжевый акцент, меню сверху", layout: "top", dark: true, swatch: ["#2a1d15", "#4a3a30", "#ff7a1f", "#2c8a9a", "#f6f1ec"], vars: { ...PULSE, ...GLASS } },
];

/** Цвета линий на графиках сравнения: различимы на фоне темы. */
const SERIES: Record<ThemeId, string[]> = {
  pulse: ["#35e08a", "#5aa9ff", "#f2c14e", "#ff7ab6", "#b48cff", "#ff9147", "#4fd6d6", "#e8ecf1", "#9fd356", "#ff5f6d", "#c9a3a8", "#7aa2ff"],
  graphite: ["#ffbe2e", "#ff5a4f", "#62a8ff", "#3fd58a", "#b993ff", "#ff8fc0", "#4fd6d6", "#f5f6f8", "#a3d95b", "#ff8d3a", "#c9a3a8", "#8ab4ff"],
  glass: ["#ff7a1f", "#6db9ff", "#f7cb4a", "#43dc98", "#c49bff", "#ff8fc0", "#4fd6d6", "#f6f1ec", "#a3d95b", "#ff4d6a", "#cfa7ac", "#8ab4ff"],
};
export const seriesColor = (i: number) => { const l = SERIES[current.id]; return l[((i % l.length) + l.length) % l.length]; };

export const themeById = (id: string | null | undefined): ThemeDef => THEMES.find((x) => x.id === id) ?? THEMES[0];

const KEY = "np.theme";
let current: ThemeDef = THEMES[0];
export const currentTheme = () => current;

/** Применяет тему ко всему окну. Возвращает её описание. */
export function applyTheme(id: string | null | undefined): ThemeDef {
  const th = themeById(id);
  current = th;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(th.vars)) root.style.setProperty(k, v);
  root.dataset.theme = th.id;
  root.style.colorScheme = th.dark ? "dark" : "light";
  try { localStorage.setItem(KEY, th.id); } catch { /* браузер без хранилища */ }
  return th;
}

/** Тема из прошлого запуска — чтобы окно не мигало до загрузки настроек. */
export function applySavedTheme(): ThemeDef {
  let id: string | null = null;
  try { id = localStorage.getItem(KEY); } catch { /* */ }
  return applyTheme(id);
}

/** Значение переменной темы — для рисования на canvas и в SVG-атрибутах. */
export function cv(name: string): string {
  return current.vars[name] ?? getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** rgba() из переменной-тройки (--ok-rgb и т. п.). */
export const rgbaVar = (name: string, a: number) => `rgba(${cv(name)}, ${a})`;
