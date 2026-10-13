import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import type { FeedItem, IncidentNotice } from "../types";
import { Icon, stripMark } from "./ui";
import { useIncidentControl } from "../control";

/** Всплывающая карточка инцидента в окне программы. */
export interface IncToast { key: number; notice: IncidentNotice }

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return t("только что");
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${t("мин назад")}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${t("ч назад")}`;
  return new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const tone = (sev: string) => (sev === "critical" ? "down" : sev === "ok" ? "ok" : sev === "warning" ? "warn" : "info");

export function IncidentToasts({ list, onClose, onOpen, toast }: {
  list: IncToast[];
  onClose: (key: number) => void;
  onOpen: (n: IncidentNotice) => void;
  toast: (m: string, k?: string) => void;
}) {
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const control = useIncidentControl();
  if (!list.length) return null;
  return (
    <div className="itoasts">
      {list.map(({ key, notice: n }) => {
        const open = n.event === "open" || n.event === "remind" || n.event === "demo";
        const canAck = control && open && n.event !== "demo" && !n.incident.ackBy && !taken.has(n.incident.id);
        return (
          <div key={key} className={"itoast " + tone(n.severity)} role="status">
            <div className="itoast-h">
              <b>{stripMark(n.title)}</b>
              <button className="itoast-x" onClick={() => onClose(key)} title={t("Скрыть")}>✕</button>
            </div>
            {n.body && <div className="itoast-b">{n.body}</div>}
            <div className="itoast-a">
              <button className="btn sm" onClick={() => { onOpen(n); onClose(key); }}>{t("Открыть")}</button>
              {canAck && (
                <button className="btn sm primary" onClick={async () => {
                  try {
                    await api.incidentAck(n.incident.id);
                    setTaken((s) => new Set(s).add(n.incident.id));
                    toast(t("Взято в работу"), "ok");
                    onClose(key);
                  } catch (e) { toast(String(e), "error"); }
                }}><Icon name="hand" size={13} />{t("Беру")}</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Колокольчик: последние уведомления — аварии, восстановления, смены маршрута. */
export function NoticeBell({ feed, unread, onSeen, onClear, onPick, onAll, active }: {
  feed: FeedItem[];
  unread: number;
  onSeen: () => void;
  onClear: () => void;
  onPick: (f: FeedItem) => void;
  onAll: () => void;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", off); window.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="nbell" ref={ref}>
      <button className={"tnav-ico" + (open || active ? " on" : "")} title={t("Уведомления")} onClick={() => { setOpen((v) => !v); onSeen(); }}>
        <Icon name="bell" size={16} />{unread > 0 && <i className="tnav-cnt">{unread > 9 ? "9+" : unread}</i>}
      </button>
      {open && (
        <div className="npop">
          <div className="npop-h">
            <b>{t("Уведомления")}</b>
            <span style={{ flex: 1 }} />
            {feed.length > 0 && <button className="btn ghost sm" onClick={onClear}>{t("Очистить")}</button>}
          </div>
          <div className="npop-l">
            {feed.length === 0 && (
              <div className="npop-empty">{t("Пока тихо. Здесь появятся аварии, восстановления и смены маршрута — по одной записи на случай, без потока «упал/поднялся».")}</div>
            )}
            {feed.map((f) => (
              <button key={f.id} className={"npop-i " + tone(f.severity)} onClick={() => { onPick(f); setOpen(false); }}>
                <i className="npop-dot" />
                <span className="npop-t">
                  <b>{stripMark(f.title)}</b>
                  {f.body && <small>{f.body}</small>}
                </span>
                <span className="npop-ts">{ago(f.ts)}</span>
              </button>
            ))}
          </div>
          <div className="npop-f">
            <button className="btn sm" onClick={() => { onAll(); setOpen(false); }}>{t("Все инциденты")} →</button>
          </div>
        </div>
      )}
    </div>
  );
}

const FEED_KEY = "np.feed";
export function loadFeed(): FeedItem[] {
  try { return JSON.parse(localStorage.getItem(FEED_KEY) || "[]") as FeedItem[]; } catch { return []; }
}
export function saveFeed(f: FeedItem[]) {
  try { localStorage.setItem(FEED_KEY, JSON.stringify(f.slice(0, 60))); } catch { /* */ }
}
