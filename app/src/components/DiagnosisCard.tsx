import { useState } from "react";
import type { Diagnosis, DiagZone, Finding } from "../types";
import { fmtTime, plural } from "../format";
import { t } from "../i18n";

const ZONE_LABEL: Record<DiagZone, string> = {
  monitor: "этот компьютер",
  local: "локальная сеть",
  internal: "внутренняя сеть",
  isp: "провайдер",
  transit: "транзит",
  dest: "сторона цели",
  target: "узел",
  parent: "вышестоящий узел",
  general: "",
};

const LEVEL_ICON = { crit: "●", warn: "▲", info: "i", ok: "✓" } as const;

interface Props {
  d: Diagnosis | null;
  loading: boolean;
  error: string | null;
  /** Анализ показывает выделенный участок и не обновляется сам. */
  frozen: boolean;
  /** У цели есть трассировка: можно перейти к хопу. */
  hops: boolean;
  onHop: (ttl: number) => void;
  onRefresh: () => void;
}

/** Разбор проблемы: что происходит, на каком участке причина и что делать. */
export function DiagnosisCard({ d, loading, error, frozen, hops, onHop, onRefresh }: Props) {
  const [open, setOpen] = useState(false);

  if (error) {
    return (
      <div className="diag warn">
        <div className="diag-head">
          <span className="diag-ico">▲</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="diag-title">{t("Не удалось выполнить анализ")}</div>
            <div className="diag-sub">{error}</div>
          </div>
          <button className="btn ghost sm" onClick={onRefresh} disabled={loading}>{loading ? t("Обновляю…") : t("Повторить")}</button>
        </div>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="diag ok">
        <div className="diag-head">
          <span className="diag-ico">…</span>
          <div className="diag-title">{t("Анализирую…")}</div>
        </div>
      </div>
    );
  }

  const main = d.findings.filter((x) => x.level === "crit" || x.level === "warn");
  const notes = d.findings.filter((x) => x.level === "info");
  const head = d.findings[0];
  // Когда проблем нет, но есть замечания — показываем их сразу, а не прячем.
  const shown = main.length ? main : notes;
  const hidden = main.length ? notes : [];
  const title = t(d.level === "ok" ? (notes.length ? "Явных проблем нет, есть замечания" : "Проблем не найдено") : "Анализ проблемы");

  return (
    <div className={"diag " + d.level}>
      <div className="diag-head">
        <span className="diag-ico">{LEVEL_ICON[d.level]}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="diag-title">{title}</div>
          <div className="diag-sub">
            {d.samples ? `${t("по")} ${plural(d.samples, "проверке", "проверкам", "проверкам")} ${t("за")} ${fmtTime(d.from, false)} – ${fmtTime(d.to, false)}` : t("нет данных за период")}
            {d.level === "ok" && !notes.length && head?.detail ? ` · ${head.detail}` : ""}
          </div>
          <div className="diag-flags">
            {d.clamped && <span className="ttag" title="Разбор строится по сырым проверкам, их много — берётся последний отрезок периода">анализ за последние 3 часа периода</span>}
            {d.coverage < 0.9 && d.samples > 0 && <span className="ttag" title="Часть периода без проверок: сон компьютера, закрытая программа или пауза цели">покрытие {Math.round(d.coverage * 100)}%</span>}
            {d.stale && <span className="ttag">данные устарели</span>}
            {frozen && <span className="ttag" title="Выделен участок графика: анализ построен по нему и не обновляется сам">выделенный участок</span>}
          </div>
        </div>
        {hidden.length > 0 && (
          <button className="btn ghost sm" onClick={() => setOpen((v) => !v)}>{open ? t("Скрыть заметки") : `${t("Заметки")}: ${hidden.length}`}</button>
        )}
        <button className="btn ghost sm" onClick={onRefresh} disabled={loading} title="Пересчитать анализ и обновить таблицу маршрута по текущим данным">
          {loading ? t("Обновляю…") : t("↻ Обновить")}
        </button>
      </div>
      <div style={loading ? { opacity: 0.45, transition: "opacity .15s" } : undefined}>
        {shown.map((x, i) => (
          <Row key={i} f={x} onHop={hops ? onHop : undefined} />
        ))}
        {open && hidden.map((x, i) => <Row key={"x" + i} f={x} onHop={hops ? onHop : undefined} />)}
      </div>
    </div>
  );
}

function Row({ f, onHop }: { f: Finding; onHop?: (ttl: number) => void }) {
  return (
    <div className={"diag-row " + f.level}>
      <span className="diag-dot" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="diag-rt">
          {f.title}
          {ZONE_LABEL[f.zone] && <span className="diag-zone">{ZONE_LABEL[f.zone]}</span>}
          {onHop && f.ttl != null && f.ttl > 0 && (
            <button className="diag-hop" onClick={() => onHop(f.ttl!)} title="Показать график этого хопа">
              хоп {f.ttl} →
            </button>
          )}
        </div>
        {f.detail && <div className="diag-detail">{f.detail}</div>}
        {f.hint && <div className="diag-hint">{t("Что делать")}: {f.hint}</div>}
      </div>
    </div>
  );
}
