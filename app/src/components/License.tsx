import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import type { LicenseStatus } from "../types";
import { Icon } from "./ui";

export type ProFeature = "wallboard" | "events" | "map" | "reports" | "operators";

const FEATURES: { k: ProFeature; title: string; text: string }[] = [
  { k: "wallboard", title: "Дашборд", text: "табло для стены или второго монитора: все узлы на одном экране, четыре вида" },
  { k: "events", title: "Инциденты", text: "проблемы склеиваются в один случай: история, хронология, кому звонить" },
  { k: "map", title: "Карта сети", text: "схема сети по трассировкам — видно, где именно рвётся связь" },
  { k: "reports", title: "Отчёты", text: "доступность и простои за период, сравнение с договором, выгрузка в CSV" },
  { k: "operators", title: "Операторы", text: "провайдеры и подрядчики: договоры, SLA, контакты для заявок" },
];

/** Поле ввода ключа с кнопкой «Активировать». */
export function LicenseForm({ onDone, toast }: { onDone: (s: LicenseStatus) => void; toast: (m: string, k?: string) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const st = await api.activateLicense(key.trim());
      onDone(st);
      setKey("");
      toast(t("Ключ принят — доступна полная версия"), "ok");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="lic-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="lic-row">
        <input
          className="input num lic-input"
          value={key}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => { setKey(e.target.value.toUpperCase()); setErr(null); }}
        />
        <button className="btn primary" disabled={busy || !key.trim()}>{busy ? t("Проверяю…") : t("Активировать")}</button>
      </div>
      {err && <div className="lic-err">{err}</div>}
    </form>
  );
}

/** Заглушка раздела, доступного только с ключом. */
export function ProGate({ feature, lic, onLicense, toast }: {
  feature: ProFeature;
  lic: LicenseStatus | null;
  onLicense: (s: LicenseStatus) => void;
  toast: (m: string, k?: string) => void;
}) {
  const f = FEATURES.find((x) => x.k === feature)!;
  return (
    <div className="pro-gate">
      <div className="pro-card">
        <div className="pro-ico"><Icon name="lock" size={22} /></div>
        <h2>{t(f.title)} — {t("в полной версии")}</h2>
        <p className="pro-lead">{t(f.text)}.</p>
        <div className="pro-cols">
          <div>
            <b>{t("Бесплатно")}</b>
            <ul>
              <li>{t("до")} {lic?.targetLimit ?? 10} {t("узлов")}</li>
              <li>{t("все цели, графики, сравнение")}</li>
              <li>{t("уведомления на компьютер, в Телеграм и на почту")}</li>
            </ul>
          </div>
          <div className="on">
            <b>{t("Полная версия")}</b>
            <ul>
              <li>{t("без ограничения по узлам")}</li>
              {FEATURES.map((x) => <li key={x.k} className={x.k === feature ? "cur" : ""}>{t(x.title)}</li>)}
            </ul>
          </div>
        </div>
        <LicenseForm onDone={onLicense} toast={toast} />
      </div>
    </div>
  );
}

/** Вкладка «Лицензия» в настройках. */
export function LicensePanel({ lic, onLicense, toast }: { lic: LicenseStatus | null; onLicense: (s: LicenseStatus) => void; toast: (m: string, k?: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  if (!lic) return null;
  return (
    <div className="card">
      <h3>{t("Лицензия")}</h3>
      {lic.licensed ? (
        <>
          <div className="lic-state ok">
            <Icon name="check" size={16} />
            <span><b>{t("Полная версия")}</b> · {t("ключ")} <span className="num">{lic.key}</span></span>
          </div>
          <div className="desc">{t("Доступно всё: без ограничения по узлам, дашборд, инциденты, карта сети, отчёты и операторы.")}</div>
          {!confirm ? (
            <button className="btn ghost sm" onClick={() => setConfirm(true)}>{t("Убрать ключ с этого компьютера…")}</button>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="c-muted" style={{ fontSize: 12 }}>{t("Программа вернётся к бесплатной версии. Цели и история сохранятся.")}</span>
              <button className="btn danger sm" onClick={async () => {
                try { onLicense(await api.deactivateLicense()); setConfirm(false); toast(t("Ключ убран")); } catch (e) { toast(String(e), "error"); }
              }}>{t("Убрать ключ")}</button>
              <button className="btn ghost sm" onClick={() => setConfirm(false)}>{t("Отмена")}</button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="lic-state">
            <Icon name="lock" size={16} />
            <span><b>{t("Бесплатная версия")}</b> · {t("узлов")} <span className="num">{lic.targets} / {lic.targetLimit}</span></span>
          </div>
          <div className="desc">{t("Без ключа можно следить за")} {lic.targetLimit} {t("узлами; дашборд, инциденты, карта сети, отчёты и операторы закрыты. Введите ключ, чтобы открыть всё.")}</div>
          <LicenseForm onDone={onLicense} toast={toast} />
        </>
      )}
    </div>
  );
}
