import { t } from "../i18n";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { EventRecord } from "../types";
import { fmtDateTime, plural } from "../format";
import { ask } from "../components/Dialogs";

const SEV: Record<string, { l: string; c: string }> = {
  critical: { l: "Критично", c: "c-down" },
  warning: { l: "Внимание", c: "c-warn" },
  info: { l: "Инфо", c: "c-info" },
  ok: { l: "Восстановление", c: "c-ok" },
  route: { l: "Маршрут", c: "c-route" },
};

export function Events({ onOpen, refreshKey }: { onOpen: (id: string, at?: number) => void; refreshKey: number }) {
  const [items, setItems] = useState<EventRecord[] | null>(null);
  const [sev, setSev] = useState<string>("all");
  const [q, setQ] = useState("");

  useEffect(() => {
    const load = () => api.events(1000).then(setItems).catch(() => setItems([]));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [refreshKey]);

  const list = (items ?? []).filter(
    (e) => (sev === "all" || e.severity === sev) && (!q || e.message.toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <>
      <div className="toolbar">
        <div className="chips">
          <button className={sev === "all" ? "on" : ""} onClick={() => setSev("all")}>{t("Все")}</button>
          {Object.entries(SEV).map(([k, v]) => (
            <button key={k} className={sev === k ? "on" : ""} onClick={() => setSev(k)}>{t(v.l)}</button>
          ))}
        </div>
        <input className="input search" placeholder={t("Поиск по событиям")} value={q} onChange={(e) => setQ(e.target.value)} />
        <span style={{ flex: 1 }} />
        <span className="c-muted">{plural(list.length, "событие", "события", "событий")}</span>
        <button className="btn" onClick={async () => { if (await ask({ title: "Очистить журнал событий?", message: "Все записи журнала по всем целям будут удалены без возможности восстановления. История проверок и графики останутся.", confirm: "Очистить", danger: true })) { await api.clearEvents(); setItems([]); } }}>{t("Очистить журнал")}</button>
      </div>
      {items === null ? (
        <div className="empty"><div>{t("Загружаю журнал…")}</div></div>
      ) : list.length === 0 && items.length > 0 ? (
        <div className="empty"><h2>{t("Ничего не найдено")}</h2><div>{t("Измените фильтр или поисковый запрос.")}</div></div>
      ) : list.length === 0 ? (
        <div className="empty"><h2>{t("Событий нет")}</h2><div>{t("Здесь появятся падения, восстановления, рост задержки и потерь, смены маршрута.")}</div></div>
      ) : (
        <div className="ev-list">
          {list.map((e) => (
            <div className="ev" key={e.id}>
              <span className="ts">{fmtDateTime(e.ts)}</span>
              <span className={SEV[e.severity]?.c ?? "c-muted"} title={t(SEV[e.severity]?.l ?? "")}>●</span>
              <span>
                <span className={"msg" + (e.severity === "route" ? " c-route" : "")}>{e.message}</span>
                {e.targetId && <span className="tg" onClick={() => onOpen(e.targetId!, e.ts)} title={t("Открыть график ±5 минут от события")}>{t("открыть →")}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
