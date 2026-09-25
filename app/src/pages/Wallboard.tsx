import { useEffect, useMemo, useRef, useState } from "react";
import type { Health, TargetSummary } from "../types";
import { HEALTH_ORDER as ORDER, KIND_LABEL } from "../types";
import { fmtMs, fmtPct, plural } from "../format";
import { problemText, sinceText, trend, TREND_TEXT, isProblem } from "../problem";
import { Icon } from "../components/ui";
import { api } from "../api";
import { t } from "../i18n";

/** Сколько проблем помещается на страницу: больше на читаемом размере не влезает. */
const PER_PAGE = 3;
/** Как часто листаются страницы проблем. */
const PAGE_MS = 10_000;
/** Пределы размера квадратика мозаики, px (верхний — при самой крупной шкале). */
const MIN_CELL = 9;
const MAX_CELL = 64;
/** Крупность: множитель всех размеров табло. Подбирается под диагональ панели. */
const SIZES = [
  { k: "m", l: "Обычно", v: 0.55 },
  { k: "l", l: "Крупно", v: 0.7 },
  { k: "xl", l: "Очень крупно", v: 0.85 },
] as const;
const MAX_SIZE = SIZES[SIZES.length - 1].v;

function load<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v == null ? d : (JSON.parse(v) as T); } catch { return d; }
}
function save(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
}

interface Card {
  key: string;
  health: Health;
  name: string;
  sub: string;
  why: string;
  since: number | null;
  s: TargetSummary | null;
  /** Сводная карточка зависимых целей: имена тех, кто ждёт родителя. */
  waiting?: string[];
}

/**
 * Табло для панели на стене: крупно — что сломалось и почему, мелко — вся сеть.
 * Ничего не прокручивается: размер мозаики подбирается под свободную высоту,
 * а если проблем больше, чем влезает, карточки листаются страницами.
 */
export function Wallboard({ items, onOpen, onExit, kiosk, onKiosk }: {
  items: TargetSummary[];
  onOpen: (id: string) => void;
  onExit: () => void;
  kiosk?: boolean;
  onKiosk?: (on: boolean) => void;
}) {
  const [now, setNow] = useState(new Date());
  // Прежняя шкала была крупнее: сохранённое значение подтягиваем к новому максимуму.
  const [size, setSize] = useState<number>(() => Math.min(load("np.wbSize", 0.7), MAX_SIZE));
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(22);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && kiosk) onKiosk?.(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kiosk, onKiosk]);

  const active = useMemo(() => items.filter((i) => i.health !== "paused"), [items]);

  const counts = useMemo(() => ({
    ok: active.filter((i) => i.health === "ok" || i.health === "unknown").length,
    warn: active.filter((i) => i.health === "warn" || i.health === "bad" || i.health === "crit").length,
    down: active.filter((i) => i.health === "down" || i.health === "dependent").length,
  }), [active]);

  // Зависимые цели не занимают место по одной: они сворачиваются в карточку родителя.
  const cards = useMemo<Card[]>(() => {
    const problems = active.filter((i) => isProblem(i.health)).sort((a, b) => ORDER[a.health] - ORDER[b.health] || b.stateSince - a.stateSince);
    const waiting = new Map<string, string[]>();
    for (const p of problems) {
      if (p.health !== "dependent" || !p.blockedBy) continue;
      if (!waiting.has(p.blockedBy)) waiting.set(p.blockedBy, []);
      waiting.get(p.blockedBy)!.push(p.name);
    }
    const out: Card[] = [];
    for (const p of problems) {
      if (p.health === "dependent") continue;
      out.push({
        key: p.id,
        health: p.health,
        name: p.name,
        sub: `${KIND_LABEL[p.kind]} · ${p.host} · ${t("группа")} ${p.group}`,
        why: problemText(p),
        since: p.stateSince,
        s: p,
      });
      const dep = waiting.get(p.name);
      if (dep?.length) {
        out.push({
          key: p.id + "/dep",
          health: "dependent",
          name: `${t("Ещё")} ${plural(dep.length, "цель ждёт", "цели ждут", "целей ждут")} ${p.name}`,
          sub: `${p.group} · ${t("зависимые цели")}`,
          why: "",
          since: null,
          s: null,
          waiting: dep,
        });
      }
    }
    // Зависимые без найденного родителя не должны потеряться.
    for (const p of problems) {
      if (p.health !== "dependent") continue;
      if (p.blockedBy && out.some((c) => c.waiting && c.name.endsWith(p.blockedBy!))) continue;
      out.push({
        key: p.id,
        health: p.health,
        name: p.name,
        sub: `${KIND_LABEL[p.kind]} · ${p.host} · ${t("группа")} ${p.group}`,
        why: problemText(p),
        since: p.stateSince,
        s: p,
      });
    }
    return out;
  }, [active]);

  const pages = Math.max(1, Math.ceil(cards.length / PER_PAGE));
  useEffect(() => { if (page >= pages) setPage(0); }, [pages, page]);
  useEffect(() => {
    if (pages < 2 || paused) return;
    const id = setInterval(() => setPage((p) => (p + 1) % pages), PAGE_MS);
    return () => clearInterval(id);
  }, [pages, paused]);
  const shown = cards.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  const groups = useMemo(() => {
    const m = new Map<string, TargetSummary[]>();
    for (const i of active) { if (!m.has(i.group)) m.set(i.group, []); m.get(i.group)!.push(i); }
    // Сначала группы с проблемами, потом крупные: важное — в левом верхнем углу.
    return [...m.entries()].sort((a, b) => {
      const pa = a[1].some((x) => isProblem(x.health)) ? 1 : 0;
      const pb = b[1].some((x) => isProblem(x.health)) ? 1 : 0;
      return pb - pa || b[1].length - a[1].length || a[0].localeCompare(b[0], "ru");
    });
  }, [active]);

  // Размер квадратика подбирается под свободную высоту: мозаика обязана влезть целиком.
  // Формулой раскладку не предсказать, поэтому ищем максимум двоичным поиском по
  // реальным измерениям — примерно шесть кадров, без дрожания размера.
  const [probe, setProbe] = useState<{ lo: number; hi: number; best: number } | null>({ lo: MIN_CELL, hi: MAX_CELL, best: MIN_CELL });
  const restart = () => {
    setProbe({ lo: MIN_CELL, hi: MAX_CELL, best: MIN_CELL });
    setCell((MIN_CELL + MAX_CELL) >> 1);
  };
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    let first = true;
    const ro = new ResizeObserver(() => { if (first) { first = false; return; } restart(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { restart(); }, [groups.length, items.length, size]);
  useEffect(() => {
    const el = mapRef.current;
    if (!el || !probe || el.clientHeight < 40) return;
    const id = requestAnimationFrame(() => {
      const fits = el.scrollHeight <= el.clientHeight + 1;
      let { lo, hi, best } = probe;
      if (fits) { best = cell; lo = cell + 1; } else hi = cell - 1;
      if (lo > hi) { setProbe(null); setCell(best); }
      else { setProbe({ lo, hi, best }); setCell((lo + hi) >> 1); }
    });
    return () => cancelAnimationFrame(id);
  }, [cell, probe]);

  const worst = cards[0];
  const head = counts.down
    ? { cls: "down", h: worst ? `${t("Авария")}: ${worst.name}` : t("Есть недоступные цели"), s: worst?.why ?? "" }
    : counts.warn
      ? { cls: "warn", h: `${t("Нужно внимание")}: ${plural(counts.warn, "цель", "цели", "целей")}`, s: worst?.why ?? "" }
      : { cls: "ok", h: t("Всё в порядке"), s: `${plural(active.length, "цель работает", "цели работают", "целей работают")} ${t("нормально")}` };

  const toggleKiosk = async () => {
    const next = !kiosk;
    onKiosk?.(next);
    await api.setFullscreen(next).catch(() => {});
  };

  return (
    <div className={"wb" + (kiosk ? " kiosk" : "")} style={{ ["--wb" as string]: size }}>
      <div className="wb-top">
        <div className="wb-time">
          <div className="wb-clock num">{now.toLocaleTimeString("ru-RU")}</div>
          <div className="wb-date">{now.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}</div>
        </div>
        <div className="wb-counts">
          <div className="wb-cnt ok"><b className="num">{counts.ok}</b><span>{t("в норме")}</span></div>
          <div className={"wb-cnt warn" + (counts.warn ? "" : " zero")}><b className="num">{counts.warn}</b><span>{t("с проблемами")}</span></div>
          <div className={"wb-cnt down" + (counts.down ? "" : " zero")}><b className="num">{counts.down}</b><span>{t("недоступны")}</span></div>
        </div>
        <div className="wb-head">
          <div className={"wb-h " + head.cls}>{head.h}</div>
          <div className="wb-hs">{head.s}</div>
        </div>
        <div className="wb-tools">
          {pages > 1 && <div className="wb-pager">{t("страница")} {page + 1}/{pages} · {t("ещё")} {cards.length - shown.length}</div>}
          <div className="chips">
            {SIZES.map((x) => (
              <button key={x.k} className={Math.abs(size - x.v) < 0.01 ? "on" : ""} title={t("Крупность текста и мозаики")}
                onClick={() => { setSize(x.v); save("np.wbSize", x.v); }}>{x.k.toUpperCase()}</button>
            ))}
          </div>
          <button className="btn" onClick={toggleKiosk}>{kiosk ? t("Выйти (Esc)") : t("На весь экран")}</button>
          {!kiosk && <button className="btn ghost" onClick={onExit}><Icon name="back" size={13} />{t("К списку")}</button>}
        </div>
      </div>

      {cards.length > 0 && (
        <div className="wb-probs" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
          {shown.map((c) => <ProblemCard key={c.key} c={c} now={now.getTime()} onOpen={onOpen} />)}
        </div>
      )}

      <div className="wb-map" ref={mapRef} style={{ ["--cell" as string]: cell + "px", ["--gap" as string]: Math.max(3, Math.round(cell * 0.26)) + "px" }}>
        {groups.map(([g, list]) => {
          const hit = list.some((x) => isProblem(x.health));
          const cols = Math.min(list.length, list.length > 12 ? 6 : list.length > 6 ? 5 : 4);
          const ok = list.filter((x) => x.health === "ok" || x.health === "unknown").length;
          return (
            <div key={g} className={"wb-grp" + (hit ? " hit" : "")}>
              <div className="wb-gname">{g}<i className="num">{ok}/{list.length}</i></div>
              <div className="wb-sq" style={{ gridTemplateColumns: `repeat(${cols}, var(--cell))` }}>
                {list.map((x) => (
                  <i key={x.id} className={"h-" + x.health} title={`${x.name} — ${problemText(x) || t("в норме")}`} onClick={() => onOpen(x.id)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProblemCard({ c, now, onOpen }: { c: Card; now: number; onOpen: (id: string) => void }) {
  const s = c.s;
  // У недоступной цели тренд задержки бессмыслен: отвечать нечему.
  const tr = s && c.health !== "down" && c.health !== "dependent" ? trend(s.spark) : null;
  return (
    <div className={"wb-card " + c.health} onClick={() => s && onOpen(s.id)}>
      <div className="wb-nm">{c.name}</div>
      <div className="wb-sub">{c.sub}</div>
      {c.waiting ? (
        <div className="wb-waiting">{c.waiting.join(" · ")}</div>
      ) : (
        <>
          <div className="wb-why">{c.why}</div>
          <div className="wb-dur">
            {c.since != null && sinceText(c.since, now)}
            {tr && c.since != null ? " · " : ""}
            {tr && t(TREND_TEXT[tr])}
          </div>
          {s && (
            <div className="wb-nums">
              <div>{t("сейчас")}<b className="num">{s.lastRtt == null ? "✕" : fmtMs(s.lastRtt, 1)}</b></div>
              <div>{t("средняя")}<b className="num">{s.avgRtt == null ? "—" : fmtMs(s.avgRtt)}</b></div>
              <div>{t("потери")}<b className="num">{fmtPct(s.lossPct)}%</b></div>
            </div>
          )}
          {s && <Spark spark={s.spark} health={c.health} />}
        </>
      )}
    </div>
  );
}

/** Крупный силуэт последних проверок: видно, нарастает проблема или отпускает. */
function Spark({ spark, health }: { spark: (number | null)[]; health: Health }) {
  const w = 460, h = 72;
  const v = spark.slice(-90);
  if (v.length < 4) return null;
  const max = Math.max(...v.map((x) => x ?? 0), 1);
  const pts = v.map((x, i) => [(i / (v.length - 1)) * w, x == null ? h - 2 : h - 4 - (x / max) * (h - 12)] as const);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const col = health === "down" || health === "crit" || health === "dependent" ? "var(--down)" : health === "bad" ? "var(--bad)" : "var(--warn)";
  return (
    <svg className="wb-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={col} opacity=".13" />
      <path d={d} fill="none" stroke={col} strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}
