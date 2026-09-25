import type {
  AlertPayload,
  DuplicatePair,
  HeatCell,
  HopSeries,
  ReportRow,
  UpdateInfo,
  EngineInfo,
  EventRecord,
  Settings,
  Target,
  TargetSummary,
  TimelinePoint,
  TraceView,
  Diagnosis,
  Topology,
} from "./types";
import { mock } from "./mock";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return mock.invoke(cmd, args) as Promise<T>;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const api = {
  engineInfo: () => call<EngineInfo>("engine_info"),
  listTargets: () => call<Target[]>("list_targets"),
  saveTarget: (target: Target) => call<Target>("save_target", { target }),
  saveTargets: (targets: Target[]) => call<number>("save_targets", { targets }),
  deleteTarget: (id: string) => call<void>("delete_target", { id }),
  setEnabled: (id: string, enabled: boolean) => call<void>("set_target_enabled", { id, enabled }),
  reorder: (ids: string[]) => call<void>("reorder_targets", { ids }),
  listGroups: () => call<string[]>("list_groups"),
  addGroup: (name: string) => call<string>("add_group", { name }),
  renameGroup: (old: string, next: string) => call<string>("rename_group", { old, new: next }),
  deleteGroup: (name: string, moveTo: string | null) => call<void>("delete_group", { name, moveTo }),
  reorderGroups: (names: string[]) => call<void>("reorder_groups", { names }),
  appLog: () => call<string>("read_log"),
  diagnosis: (id: string, from: number, to: number) => call<Diagnosis>("get_diagnosis", { id, from, to }),
  setTemplateTargets: (templateId: string, ids: string[]) => call<number>("set_template_targets", { templateId, ids }),
  moveToGroup: (ids: string[], group: string) => call<number>("move_to_group", { ids, group }),
  // У HTTP(S) задержка не окрашивается: статус сайта определяется кодом ответа.
  summaries: () => call<TargetSummary[]>("get_summaries").then((l) => l.map(gradeSummary)),
  trace: (id: string, from: number, to: number) => call<TraceView>("get_trace", { id, from, to }),
  timeline: (id: string, ttl: number | null, from: number, to: number, points: number) =>
    call<TimelinePoint[]>("get_timeline", { id, ttl, from, to, points }),
  timelines: (ids: string[], from: number, to: number, points: number) =>
    call<Record<string, TimelinePoint[]>>("get_timelines", { ids, from, to, points }),
  uptime: (id: string, hours: number) => call<number | null>("get_uptime", { id, hours }),
  events: (limit: number, targetId?: string | null) => call<EventRecord[]>("get_events", { limit, targetId: targetId ?? null }),
  clearHistory: (withEvents: boolean) => call<void>("clear_history", { withEvents }),
  historyStats: () => call<{ samples: number; rollups: number; events: number; dbBytes: number }>("history_stats"),
  clearEvents: () => call<void>("clear_events"),
  settings: () => call<Settings>("get_settings"),
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),
  testChannel: (channel: string) => call<void>("test_channel", { channel }),
  testSystemNotification: () => call<void>("test_system_notification"),
  findDuplicates: () => call<DuplicatePair[]>("find_duplicates"),
  mergeDuplicates: (pairs: DuplicatePair[]) => call<number>("merge_duplicates", { pairs }),
  report: (from: number, to: number) => call<ReportRow[]>("get_report", { from, to }),
  heatmap: (id: string, from: number, to: number) => call<HeatCell[]>("get_heatmap", { id, from, to }),
  hopTimelines: (id: string, from: number, to: number, points: number) => call<HopSeries[]>("get_hop_timelines", { id, from, to, points }),
  checkUpdate: () => call<UpdateInfo | null>("check_update"),
  installUpdate: () => call<void>("install_update"),
  updateSource: () => call<string | null>("update_source"),
  topology: () => call<Topology>("get_topology"),
  mapLayout: () => call<string | null>("get_map_layout"),
  saveMapLayout: (layout: string) => call<void>("save_map_layout", { layout }),
  projectPage: () => call<string | null>("project_page"),
  openProjectPage: () => call<void>("open_project_page"),

  async exportReport(from: number, to: number): Promise<string | null> {
    if (!isTauri) return "демо-режим";
    const { save } = await import("@tauri-apps/plugin-dialog");
    const d = (ts: number) => new Date(ts).toLocaleDateString("ru-RU").replace(/\./g, "-");
    const path = await save({ defaultPath: `NetPulse-отчёт_${d(from)}_${d(to)}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return null;
    await call("export_report", { from, to, path });
    return path;
  },

  async onUpdate(cb: (u: UpdateInfo) => void): Promise<() => void> {
    if (!isTauri) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<UpdateInfo>("update-available", (e) => cb(e.payload));
  },

  async exportCsv(id: string, name: string, from: number, to: number): Promise<string | null> {
    if (!isTauri) {
      await mock.invoke("export_csv", { id, from, to });
      return "демо-режим";
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const safe = name.replace(/[^\p{L}\p{N}._-]+/gu, "_");
    const path = await save({ defaultPath: `${safe}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return null;
    await call("export_csv", { id, from, to, path });
    return path;
  },

  async exportConfig(includeSettings: boolean): Promise<string | null> {
    if (!isTauri) return "демо-режим";
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: "netpulse-config.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return null;
    await call("export_config", { path, includeSettings });
    return path;
  },

  async importConfig(replace: boolean): Promise<number | null> {
    if (!isTauri) return 0;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return null;
    return call<number>("import_config", { path, replace });
  },

  async onAlert(cb: (p: AlertPayload) => void): Promise<() => void> {
    if (!isTauri) return mock.onAlert(cb);
    const { listen } = await import("@tauri-apps/api/event");
    return listen<AlertPayload>("alert", (e) => cb(e.payload));
  },

  async setFullscreen(on: boolean) {
    if (!isTauri) {
      if (on) await document.documentElement.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      return;
    }
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
  },

  async startDragging() {
    if (!isTauri) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  },
};

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** Для HTTP(S) убираем пороги задержки из отображения (цвета, зоны графика). */
export function gradeSummary(s: TargetSummary): TargetSummary {
  if (s.kind !== "http") return s;
  return { ...s, thresholds: { ...s.thresholds, warnMs: Infinity, badMs: Infinity, critMs: Infinity } };
}
