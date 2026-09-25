import type { CheckKind } from "./types";

export interface ParsedLine {
  raw: string;
  host: string;
  name: string;
  port: number | null;
  error: string | null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(:\d{1,5})?$/;
const IPV6 = /^\[?[0-9a-f]*:[0-9a-f:]+\]?(:\d{1,5})?$/i;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}\.?(:\d{1,5})?$/i;
const URL_RE = /^https?:\/\/\S+$/i;

export function looksLikeHost(token: string): boolean {
  const t = token.trim();
  return URL_RE.test(t) || IPV4.test(t) || (IPV6.test(t) && (t.match(/:/g)?.length ?? 0) >= 2) || HOSTNAME.test(t);
}

/**
 * Разбор строки списка целей. Понимает любые варианты:
 *   `10.0.0.1`
 *   `10.0.0.1 Имя с пробелами`
 *   `Имя, host.ru`   `Имя;host.ru`   `Имя<TAB>host.ru`
 *   `host.ru Имя`    `Имя host.ru`
 * Адрес — первый токен, похожий на IP/домен/URL; всё остальное — название.
 */
export function parseLine(raw: string, kind: CheckKind, defaultPort: number | null = null): ParsedLine | null {
  const line = raw.trim();
  if (!line || line.startsWith("#") || line.startsWith("//")) return null;

  const parts = /[,;\t]/.test(line)
    ? line.split(/[,;\t]+/).map((s) => s.trim()).filter(Boolean)
    : line.split(/\s+/).filter(Boolean);

  let idx = -1;
  if (looksLikeHost(parts[0])) idx = 0;
  else if (looksLikeHost(parts[parts.length - 1])) idx = parts.length - 1;
  else idx = parts.findIndex(looksLikeHost);

  if (idx < 0) {
    // Внутри частей через запятую адрес может быть с пробелами вокруг — пробуем по словам.
    const words = line.split(/[\s,;]+/).filter(Boolean);
    const w = words.findIndex(looksLikeHost);
    if (w < 0) return { raw: line, host: "", name: line, port: null, error: "не найден IP или домен" };
    return finish(line, words[w], words.filter((_, i) => i !== w).join(" "), kind, defaultPort);
  }
  return finish(line, parts[idx], parts.filter((_, i) => i !== idx).join(" "), kind, defaultPort);
}

function finish(raw: string, hostTok: string, name: string, kind: CheckKind, defaultPort: number | null): ParsedLine {
  let host = hostTok.trim().replace(/[.,;]+$/, "");
  let port: number | null = null;
  if (!URL_RE.test(host)) {
    const m = host.match(/^(\[[^\]]+\]|[^:]+):(\d{1,5})$/);
    if (m) {
      host = m[1].replace(/^\[|\]$/g, "");
      port = Number(m[2]);
    }
  }
  if (kind === "tcp" && port == null) port = defaultPort;
  if (kind === "tcp" && port == null) {
    return { raw, host, name: name.trim(), port, error: "для TCP укажите порт: адрес:порт" };
  }
  if (kind === "http" && !URL_RE.test(host)) host = port ? `https://${host}:${port}` : `https://${host}`;
  return { raw, host, name: name.trim(), port: kind === "tcp" ? port : null, error: null };
}

export function parseList(text: string, kind: CheckKind, defaultPort: number | null = null): ParsedLine[] {
  return text.split(/\r?\n/).map((l) => parseLine(l, kind, defaultPort)).filter((x): x is ParsedLine => x !== null);
}
