import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------- Подтверждение
// Своё окно вместо window.confirm: системные диалоги WebView на macOS/Windows
// работают по-разному, а это выглядит одинаково и в тёмной теме.

interface ConfirmOpts {
  title: string;
  message?: ReactNode;
  confirm?: string;
  danger?: boolean;
}

let pushConfirm: ((o: ConfirmOpts, resolve: (v: boolean) => void) => void) | null = null;

export function ask(o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => (pushConfirm ? pushConfirm(o, resolve) : resolve(window.confirm(o.title))));
}

export function ConfirmHost() {
  const [state, setState] = useState<{ o: ConfirmOpts; resolve: (v: boolean) => void } | null>(null);
  useEffect(() => {
    pushConfirm = (o, resolve) => setState({ o, resolve });
    return () => { pushConfirm = null; };
  }, []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(false); }
      // Опасное действие подтверждается только мышью или пробелом на кнопке.
      if (e.key === "Enter" && !state.o.danger) { e.stopPropagation(); close(true); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const o = state?.o;
  if (!state || !o) return null;
  return (
    <div className="modal-back" style={{ zIndex: 120 }} onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="modal" style={{ width: "min(420px, calc(100vw - 40px))" }}>
        <div className="modal-b" style={{ paddingTop: 20 }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>{o.title}</h2>
          {o.message && <div className="c-muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{o.message}</div>}
        </div>
        <div className="modal-f" style={{ borderTop: 0, paddingTop: 4 }}>
          <button className="btn ghost" onClick={() => close(false)}>Отмена</button>
          <button className={"btn " + (o.danger ? "danger-solid" : "primary")} onClick={() => close(true)} autoFocus={!o.danger}>{o.confirm ?? "OK"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Контекстное меню

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  separator?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={it.danger ? "danger" : ""}
            disabled={it.disabled}
            onClick={() => { onClose(); it.onClick?.(); }}
          >
            <span>{it.label}</span>
            {it.hint && <small>{it.hint}</small>}
          </button>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Ввод текста / выбор из списка

interface PromptOpts {
  title: string;
  message?: ReactNode;
  label?: string;
  value?: string;
  placeholder?: string;
  confirm?: string;
  /** Если задано — вместо поля ввода список выбора. */
  options?: string[];
  /** Вернуть текст ошибки, чтобы не закрывать окно. */
  validate?: (v: string) => string | null;
}

let pushPrompt: ((o: PromptOpts, resolve: (v: string | null) => void) => void) | null = null;

export function askText(o: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => (pushPrompt ? pushPrompt(o, resolve) : resolve(window.prompt(o.title, o.value ?? ""))));
}

export function PromptHost() {
  const [state, setState] = useState<{ o: PromptOpts; resolve: (v: string | null) => void } | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    pushPrompt = (o, resolve) => {
      setValue(o.value ?? o.options?.[0] ?? "");
      setError(null);
      setState({ o, resolve });
    };
    return () => { pushPrompt = null; };
  }, []);

  const o = state?.o;
  if (!state || !o) return null;
  const close = (v: string | null) => {
    state.resolve(v);
    setState(null);
  };
  const submit = () => {
    const err = o.validate?.(value) ?? (value.trim() ? null : "поле не может быть пустым");
    if (err) return setError(err);
    close(value.trim());
  };

  return (
    <div className="modal-back" style={{ zIndex: 120 }} onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <div className="modal" style={{ width: "min(440px, calc(100vw - 40px))" }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } }}>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="modal-b" style={{ paddingTop: 20 }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>{o.title}</h2>
            {o.message && <div className="c-muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>{o.message}</div>}
            <label className="field">
              {o.label && <span>{o.label}</span>}
              {o.options ? (
                <select className="select" value={value} onChange={(e) => setValue(e.target.value)} autoFocus>
                  {o.options.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              ) : (
                <input
                  className="input"
                  value={value}
                  placeholder={o.placeholder}
                  maxLength={60}
                  onChange={(e) => { setValue(e.target.value); setError(null); }}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                />
              )}
            </label>
            {error && <div className="c-down" style={{ fontSize: 12, marginTop: 6 }}>{error}</div>}
          </div>
          <div className="modal-f" style={{ borderTop: 0, paddingTop: 4 }}>
            <button type="button" className="btn ghost" onClick={() => close(null)}>Отмена</button>
            <button type="submit" className="btn primary">{o.confirm ?? "OK"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Удаление группы

export type GroupDeleteChoice = { moveTo: string } | { deleteTargets: true };

interface GroupDeleteOpts {
  name: string;
  count: number;
  others: string[];
}

let pushGroupDelete: ((o: GroupDeleteOpts, resolve: (v: GroupDeleteChoice | null) => void) => void) | null = null;

export function askGroupDelete(o: GroupDeleteOpts): Promise<GroupDeleteChoice | null> {
  return new Promise((resolve) => (pushGroupDelete ? pushGroupDelete(o, resolve) : resolve(null)));
}

export function GroupDeleteHost() {
  const [state, setState] = useState<{ o: GroupDeleteOpts; resolve: (v: GroupDeleteChoice | null) => void } | null>(null);
  const [mode, setMode] = useState<"move" | "delete">("move");
  const [dest, setDest] = useState("");
  const [newName, setNewName] = useState("");

  useEffect(() => {
    pushGroupDelete = (o, resolve) => {
      setMode("move");
      setDest(o.others[0] ?? "__new__");
      setNewName("Общее");
      setState({ o, resolve });
    };
    return () => { pushGroupDelete = null; };
  }, []);

  const o = state?.o;
  if (!state || !o) return null;
  const close = (v: GroupDeleteChoice | null) => {
    state.resolve(v);
    setState(null);
  };
  const target = dest === "__new__" ? newName.trim() : dest;
  const canSubmit = o.count === 0 || mode === "delete" || (target !== "" && target !== o.name);

  return (
    <div className="modal-back" style={{ zIndex: 120 }} onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <div className="modal" style={{ width: "min(480px, calc(100vw - 40px))" }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } }}>
        <div className="modal-b" style={{ paddingTop: 20 }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Удалить группу «{o.name}»?</h2>
          {o.count === 0 ? (
            <div className="c-muted" style={{ fontSize: 12.5 }}>В группе нет целей.</div>
          ) : (
            <>
              <div className="c-muted" style={{ fontSize: 12.5, marginBottom: 12 }}>В группе целей: <b className="c-muted">{o.count}</b>. Что с ними сделать?</div>
              <label className="radio">
                <input type="radio" checked={mode === "move"} onChange={() => setMode("move")} />
                <span>Перенести в группу</span>
              </label>
              {mode === "move" && (
                <div style={{ display: "grid", gap: 8, margin: "8px 0 12px 26px" }}>
                  <select className="select" value={dest} onChange={(e) => setDest(e.target.value)}>
                    {o.others.map((g) => <option key={g} value={g}>{g}</option>)}
                    <option value="__new__">+ Новая группа…</option>
                  </select>
                  {dest === "__new__" && (
                    <input className="input" value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} placeholder="Название новой группы" autoFocus />
                  )}
                </div>
              )}
              <label className="radio">
                <input type="radio" checked={mode === "delete"} onChange={() => setMode("delete")} />
                <span className="c-down">Удалить группу вместе с целями и их историей</span>
              </label>
            </>
          )}
        </div>
        <div className="modal-f" style={{ borderTop: 0, paddingTop: 4 }}>
          <button className="btn ghost" onClick={() => close(null)}>Отмена</button>
          <button
            className={"btn " + (mode === "delete" && o.count > 0 ? "danger-solid" : "primary")}
            disabled={!canSubmit}
            onClick={() => close(o.count === 0 ? { moveTo: "" } : mode === "delete" ? { deleteTargets: true } : { moveTo: target })}
          >
            {o.count === 0 ? "Удалить" : mode === "delete" ? "Удалить всё" : "Перенести и удалить"}
          </button>
        </div>
      </div>
    </div>
  );
}
