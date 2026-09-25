import { t } from "../i18n";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Health, Thresholds } from "../types";
import { HEALTH_LABEL, VOIP_THRESHOLDS } from "../types";

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="sw" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Field({ label, hint, full, children }: { label: string; hint?: ReactNode; full?: boolean; children: ReactNode }) {
  return (
    <label className={"field" + (full ? " full" : "")}>
      <span>{label}</span>
      {children}
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}

export function NumInput({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <input
      className="input num"
      type="number"
      value={Number.isFinite(value) ? value : ""}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
    />
  );
}

/** Поля порогов: две ровные группы — «Задержка, мс» (3 уровня) и «Потери, %» (2 уровня). */
export function ThresholdFields({ value, onChange, latency = true, voip = latency }: { value: Thresholds; onChange: (t: Thresholds) => void; latency?: boolean; voip?: boolean }) {
  const voipOn = (value.jitterWarn ?? 0) > 0 || (value.jitterCrit ?? 0) > 0 || (value.mosWarn ?? 0) > 0 || (value.mosCrit ?? 0) > 0;
  const [voipOpen, setVoipOpen] = useState(voipOn);
  useEffect(() => { if (voipOn) setVoipOpen(true); }, [voipOn]);
  const f = (k: keyof Thresholds, label: string, lvl: string, step = 1, col?: number) => (
    <label className="field" style={col ? { gridColumn: col } : undefined}>
      <span className="th-label"><i className={"lvl " + lvl} />{label}</span>
      <NumInput value={value[k]} step={step} min={0} onChange={(v) => onChange({ ...value, [k]: v })} />
    </label>
  );
  // Одна сетка: 3 + 2 равные колонки с разделителем: все поля одной ширины и стоят по одной линии.
  return (
    <div className="th-grid">
      {latency ? (
        <>
          <div className="th-title" style={{ gridColumn: "1 / 4" }}>{t("Задержка, мс")}</div>
          <div className="th-title" style={{ gridColumn: "5 / 7" }}>{lossTitle}</div>
          {f("warnMs", "Жёлтый выше", "warn")}
          {f("badMs", "Оранжевый выше", "bad")}
          {f("critMs", "Красный выше", "crit")}
        </>
      ) : (
        <>
          <div className="th-title" style={{ gridColumn: "1 / 4" }}>{t("Статус сайта")}</div>
          <div className="th-title" style={{ gridColumn: "5 / 7" }}>{lossTitle}</div>
          <div className="th-note" style={{ gridColumn: "1 / 4" }}>
            <span><i className="lvl ok" />{t("1xx, 2xx, 3xx — в норме")}</span>
            <span><i className="lvl crit" />{t("4xx, 5xx, нет ответа — красный")}</span>
            <small>{t("Время ответа видно на графике, но на цвет статуса не влияет.")}</small>
          </div>
        </>
      )}
      {f("warnLoss", "Жёлтый выше", "warn", 0.5, 5)}
      {f("badLoss", "Красный выше", "crit", 0.5, 6)}
      {voip && (
        <div className="th-voip" style={{ gridColumn: "1 / 7" }}>
          <button type="button" className="btn ghost sm" onClick={() => setVoipOpen(!voipOpen)}>
            {voipOpen ? "▾" : "▸"} Качество связи для телефонии (jitter, MOS){voipOn ? "" : " — выключено"}
          </button>
          {voipOpen && (
            <>
              <button type="button" className="btn sm" onClick={() => onChange({ ...value, ...VOIP_THRESHOLDS })} title={t("Jitter 20 / 30 мс, MOS 4.0 / 3.6")}>{t("Рекомендуемые")}</button>
              {voipOn && <button type="button" className="btn ghost sm" onClick={() => onChange({ ...value, jitterWarn: 0, jitterCrit: 0, mosWarn: 0, mosCrit: 0 })}>{t("Выключить")}</button>}
            </>
          )}
        </div>
      )}
      {voip && voipOpen && (
        <>
          <div className="th-title" style={{ gridColumn: "1 / 4" }} title={t("Для голоса хорошо: jitter до 20–30 мс, MOS от 4.0")}>{t("Jitter, мс")} <span className="c-muted" style={{ fontWeight: 400 }}>{t("· 0 — не проверять")}</span></div>
          <div className="th-title" style={{ gridColumn: "5 / 7" }}>MOS (1–4.5) <span className="c-muted" style={{ fontWeight: 400 }}>{t("· 0 — не проверять")}</span></div>
          {f("jitterWarn", "Жёлтый выше", "warn", 1, 1)}
          {f("jitterCrit", "Красный выше", "crit", 1, 2)}
          {f("mosWarn", "Жёлтый ниже", "warn", 0.1, 5)}
          {f("mosCrit", "Красный ниже", "crit", 0.1, 6)}
        </>
      )}
    </div>
  );
}

const lossTitle = "Потери (неудачные проверки), %";

/** Значок «режим тишины» у цели. */
export const MutedBadge = ({ on }: { on: boolean }) =>
  on ? null : <span className="muted-badge" title={t("Режим тишины: уведомления выключены, события пишутся в журнал")}><Icon name="bellOff" size={12} /></span>;

/** Цветная точка состояния. Подпись дублирует цвет: он не единственный признак. */
export const Dot = ({ h }: { h: Health }) => <span className={"dot " + h} title={HEALTH_LABEL[h]} />;

/** Шильдик «сменился маршрут» — виден 30 минут после смены. */
export function RouteBadge({ at, text }: { at: number | null; text: string | null }) {
  if (!at || Date.now() - at > 30 * 60e3) return null;
  const min = Math.max(0, Math.round((Date.now() - at) / 60e3));
  const time = new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return (
    <span className="route-badge" title={`Маршрут сменился в ${time}${text ? `\n${text}` : ""}`}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 17h5l6-10h5M17 4l3 3-3 3M17 14l3 3-3 3M4 7h5l2 3" /></svg>
      сменился маршрут{min > 0 ? ` · ${min} мин` : ""}
    </span>
  );
}

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M2 13h5l2-5 3 10 2.5-13L17 13h5" stroke="var(--accent)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type IconName = "chart" | "grid" | "list" | "bell" | "gear" | "plus" | "back" | "pause" | "play" | "edit" | "trash" | "download" | "search" | "tiles" | "rows" | "bellOff" | "report" | "collapse" | "expand" | "map";
const paths: Record<IconName, string> = {
  chart: "M3 7h18M3 12h4l2-3 3 6 2-3h7M3 17h18",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  list: "M4 6h16M4 12h16M4 18h16",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  bellOff: "M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8M10 20a2 2 0 0 0 4 0M3 3l18 18",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L15 3.5h-4l-.3 2.5a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.4z",
  plus: "M12 5v14M5 12h14",
  back: "M15 5l-7 7 7 7",
  pause: "M8 5v14M16 5v14",
  play: "M7 5l12 7-12 7z",
  edit: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  tiles: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  map: "M3 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M17 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M10 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 6h10M6 7.8l5 8.4M18 7.8l-5 8.4",
  rows: "M4 5h16v4H4zM4 11h16v4H4zM4 17h16v2H4z",
  report: "M6 3h9l4 4v14H6zM14 3v5h5M9 17v-3M12 17v-6M15 17v-4",
  collapse: "M4 5h16v14H4zM9 5v14M16 9l-3 3 3 3",
  expand: "M4 5h16v14H4zM9 5v14M13 9l3 3-3 3",
};

export function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}
