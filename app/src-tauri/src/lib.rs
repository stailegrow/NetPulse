use netpulse_core::model::{
    ConfigBundle, DuplicatePair, EventRecord, HeatCell, HopSeries, ReportRow, Health, Settings, Target, TargetSummary, TimelinePoint, TraceView,
};
use netpulse_core::{EngineInfo, Monitor};
use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

type Mon<'a> = State<'a, Arc<Monitor>>;
type R<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

// ---------------------------------------------------------------- команды

/// Тяжёлые операции с базой выполняем вне рабочих потоков проверок, иначе мониторинг замирает.
async fn blocking<T: Send + 'static>(m: &State<'_, Arc<Monitor>>, f: impl FnOnce(Arc<Monitor>) -> Result<T, String> + Send + 'static) -> R<T> {
    let m = m.inner().clone();
    tauri::async_runtime::spawn_blocking(move || f(m)).await.map_err(|err| err.to_string())?
}

#[tauri::command]
fn engine_info(m: Mon) -> EngineInfo {
    m.engine_info()
}

#[tauri::command]
fn list_targets(m: Mon) -> Vec<Target> {
    m.list_targets()
}

#[tauri::command]
async fn save_target(m: State<'_, Arc<Monitor>>, target: Target) -> R<Target> {
    m.upsert_target(target).map_err(e)
}

#[tauri::command]
async fn save_targets(m: State<'_, Arc<Monitor>>, targets: Vec<Target>) -> R<usize> {
    let mut n = 0;
    for t in targets {
        m.upsert_target(t).map_err(e)?;
        n += 1;
    }
    Ok(n)
}

#[tauri::command]
async fn delete_target(m: State<'_, Arc<Monitor>>, id: String) -> R<()> {
    m.delete_target(&id).map_err(e)
}

#[tauri::command]
async fn set_target_enabled(m: State<'_, Arc<Monitor>>, id: String, enabled: bool) -> R<()> {
    m.set_enabled(&id, enabled).map_err(e)
}

#[tauri::command]
async fn reorder_targets(m: State<'_, Arc<Monitor>>, ids: Vec<String>) -> R<()> {
    m.reorder(ids).map_err(e)
}

#[tauri::command]
async fn list_groups(m: State<'_, Arc<Monitor>>) -> R<Vec<String>> {
    Ok(m.groups())
}

#[tauri::command]
async fn add_group(m: State<'_, Arc<Monitor>>, name: String) -> R<String> {
    m.add_group(&name).map_err(e)
}

#[tauri::command]
async fn rename_group(m: State<'_, Arc<Monitor>>, old: String, new: String) -> R<String> {
    m.rename_group(&old, &new).map_err(e)
}

#[tauri::command]
async fn delete_group(m: State<'_, Arc<Monitor>>, name: String, move_to: Option<String>) -> R<()> {
    m.delete_group(&name, move_to.as_deref()).map_err(e)
}

#[tauri::command]
async fn move_to_group(m: State<'_, Arc<Monitor>>, ids: Vec<String>, group: String) -> R<usize> {
    let n = m.move_targets(&ids, &group).map_err(e)?;
    m.apply_group_templates(&ids).map_err(e)?;
    Ok(n)
}

#[tauri::command]
async fn get_diagnosis(m: State<'_, Arc<Monitor>>, id: String, from: i64, to: i64) -> R<netpulse_core::analyze::Diagnosis> {
    blocking(&m, move |m| m.diagnose(&id, from, to).map_err(e)).await
}

#[tauri::command]
async fn get_topology(m: State<'_, Arc<Monitor>>) -> R<netpulse_core::model::Topology> {
    blocking(&m, |m| Ok(m.topology())).await
}

#[tauri::command]
async fn get_map_layout(m: State<'_, Arc<Monitor>>) -> R<Option<String>> {
    blocking(&m, |m| m.map_layout().map_err(e)).await
}

#[tauri::command]
async fn save_map_layout(m: State<'_, Arc<Monitor>>, layout: String) -> R<()> {
    blocking(&m, move |m| m.save_map_layout(&layout).map_err(e)).await
}

#[tauri::command]
async fn read_log(m: State<'_, Arc<Monitor>>) -> R<String> {
    blocking(&m, |m| Ok(netpulse_core::logging::tail(std::path::Path::new(&m.engine_info().data_dir), 400))).await
}

#[tauri::command]
async fn set_template_targets(m: State<'_, Arc<Monitor>>, template_id: String, ids: Vec<String>) -> R<usize> {
    m.set_template_targets(&template_id, &ids).map_err(e)
}

#[tauri::command]
async fn reorder_groups(m: State<'_, Arc<Monitor>>, names: Vec<String>) -> R<()> {
    m.reorder_groups(names).map_err(e)
}

#[tauri::command]
async fn get_summaries(m: State<'_, Arc<Monitor>>) -> R<Vec<TargetSummary>> {
    Ok(m.summaries())
}

#[tauri::command]
async fn get_trace(m: State<'_, Arc<Monitor>>, id: String, from: i64, to: i64) -> R<TraceView> {
    blocking(&m, move |m| m.trace_view(&id, from, to).map_err(e)).await
}

#[tauri::command]
async fn get_timeline(m: State<'_, Arc<Monitor>>, id: String, ttl: Option<u8>, from: i64, to: i64, points: usize) -> R<Vec<TimelinePoint>> {
    m.timeline(&id, ttl, from, to, points).map_err(e)
}

#[tauri::command]
async fn get_timelines(
    m: State<'_, Arc<Monitor>>,
    ids: Vec<String>,
    from: i64,
    to: i64,
    points: usize,
) -> R<std::collections::HashMap<String, Vec<TimelinePoint>>> {
    Ok(m.timelines(&ids, from, to, points))
}

#[tauri::command]
async fn get_uptime(m: State<'_, Arc<Monitor>>, id: String, hours: u32) -> R<Option<f32>> {
    m.uptime(&id, hours).map_err(e)
}

#[tauri::command]
async fn get_events(m: State<'_, Arc<Monitor>>, limit: usize, target_id: Option<String>) -> R<Vec<EventRecord>> {
    blocking(&m, move |m| m.events(limit, target_id.as_deref()).map_err(e)).await
}

#[tauri::command]
async fn clear_history(m: State<'_, Arc<Monitor>>, with_events: bool) -> R<()> {
    blocking(&m, move |m| m.clear_history(with_events).map_err(e)).await
}

#[tauri::command]
async fn history_stats(m: State<'_, Arc<Monitor>>) -> R<netpulse_core::monitor::HistoryStats> {
    blocking(&m, |m| m.history_stats().map_err(e)).await
}

#[tauri::command]
async fn clear_events(m: State<'_, Arc<Monitor>>) -> R<()> {
    m.clear_events().map_err(e)
}

#[tauri::command]
fn get_settings(m: Mon) -> Settings {
    m.settings()
}

#[tauri::command]
async fn save_settings(app: AppHandle, m: State<'_, Arc<Monitor>>, settings: Settings) -> R<()> {
    let autostart = app.autolaunch();
    let enabled = autostart.is_enabled().unwrap_or(false);
    if settings.launch_at_login != enabled {
        let r = if settings.launch_at_login { autostart.enable() } else { autostart.disable() };
        r.map_err(|err| format!("автозапуск: {err}"))?;
    }
    blocking(&m, move |m| m.save_settings(settings).map_err(e)).await
}

#[tauri::command]
async fn test_channel(m: State<'_, Arc<Monitor>>, channel: String) -> R<()> {
    let m = m.inner().clone();
    m.test_channel(&channel).await.map_err(e)
}

#[tauri::command]
fn test_system_notification(app: AppHandle) -> R<()> {
    app.notification()
        .builder()
        .title("NetPulse")
        .body("Тестовое уведомление — всё работает ✅")
        .show()
        .map_err(e)
}

#[tauri::command]
async fn export_csv(m: State<'_, Arc<Monitor>>, id: String, from: i64, to: i64, path: String) -> R<usize> {
    blocking(&m, move |m| {
        let data = m.export_csv(&id, from, to).map_err(e)?;
        std::fs::write(&path, data.as_bytes()).map_err(e)?;
        Ok(data.lines().count().saturating_sub(1))
    })
    .await
}

#[tauri::command]
async fn export_config(m: State<'_, Arc<Monitor>>, path: String, include_settings: bool) -> R<()> {
    blocking(&m, move |m| {
        let bundle = m.export_config(include_settings);
        let json = serde_json::to_string_pretty(&bundle).map_err(e)?;
        std::fs::write(path, json).map_err(e)
    })
    .await
}

#[tauri::command]
async fn import_config(m: State<'_, Arc<Monitor>>, path: String, replace: bool) -> R<usize> {
    blocking(&m, move |m| {
        let data = std::fs::read_to_string(path).map_err(e)?;
        let bundle: ConfigBundle = serde_json::from_str(&data).map_err(|err| format!("неверный файл конфигурации: {err}"))?;
        m.import_config(bundle, replace).map_err(e)
    })
    .await
}

#[tauri::command]
async fn find_duplicates(m: State<'_, Arc<Monitor>>) -> R<Vec<DuplicatePair>> {
    Ok(m.find_duplicates())
}

#[tauri::command]
async fn merge_duplicates(m: State<'_, Arc<Monitor>>, pairs: Vec<DuplicatePair>) -> R<usize> {
    m.merge_duplicates(&pairs).map_err(e)
}

#[tauri::command]
async fn get_report(m: State<'_, Arc<Monitor>>, from: i64, to: i64) -> R<Vec<ReportRow>> {
    blocking(&m, move |m| m.report(from, to).map_err(e)).await
}

#[tauri::command]
async fn export_report(m: State<'_, Arc<Monitor>>, from: i64, to: i64, path: String) -> R<()> {
    blocking(&m, move |m| {
        let data = m.report_csv(from, to).map_err(e)?;
        std::fs::write(&path, data.as_bytes()).map_err(e)
    })
    .await
}

#[tauri::command]
async fn get_heatmap(m: State<'_, Arc<Monitor>>, id: String, from: i64, to: i64) -> R<Vec<HeatCell>> {
    blocking(&m, move |m| m.heatmap(&id, from, to).map_err(e)).await
}

#[tauri::command]
async fn get_hop_timelines(m: State<'_, Arc<Monitor>>, id: String, from: i64, to: i64, points: usize) -> R<Vec<HopSeries>> {
    blocking(&m, move |m| m.hop_timelines(&id, from, to, points).map_err(e)).await
}

// ---------------------------------------------------------------- обновления

/// Публичный ключ подписи обновлений подставляется скриптом сборки.
const UPDATER_PUBKEY: Option<&str> = option_env!("NETPULSE_UPDATER_PUBKEY");
/// Репозиторий GitHub с релизами (владелец/репозиторий) — встроен в программу.
/// Хранится в app/src-tauri/update-repo.txt, туда его записывает build-mac.sh --repo.
const UPDATE_REPO: &str = include_str!("../update-repo.txt");
// Токен доступа в сборку больше не встраивается: репозиторий обновлений читается анонимно.

#[tauri::command]
fn update_source() -> Option<String> {
    let r = UPDATE_REPO.trim();
    (!r.is_empty()).then(|| format!("https://github.com/{r}/releases"))
}

/// Страница проекта — для кнопки в разделе «О программе».
#[tauri::command]
fn project_page() -> Option<String> {
    let r = UPDATE_REPO.trim().trim_matches('/');
    (!r.is_empty() && r.contains('/')).then(|| format!("https://github.com/{r}"))
}

/// Открывает страницу проекта в браузере. Открывается только адрес, встроенный
/// в сборку: произвольные ссылки из интерфейса запускать нельзя.
#[tauri::command]
fn open_project_page() -> R<()> {
    let url = project_page().ok_or("в эту сборку не встроен адрес проекта")?;
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map_err(|err| format!("не удалось открыть браузер: {err}"))?;
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
    date: Option<String>,
}

fn updater(app: &AppHandle, m: &Monitor) -> R<tauri_plugin_updater::Updater> {
    let _ = m;
    let repo = UPDATE_REPO.trim().trim_matches('/').to_string();
    if repo.is_empty() || !repo.contains('/') {
        return Err("в эту сборку не встроен адрес обновлений".into());
    }
    let Some(key) = UPDATER_PUBKEY.filter(|k| !k.trim().is_empty()) else {
        return Err("эта сборка без ключа обновлений — соберите программу скриптом build-mac.sh".into());
    };
    // Описание версии берётся из последнего релиза; если релизы временно недоступны —
    // из того же файла в самом репозитории. Оба адреса открыты: ни токен, ни вход
    // в GitHub не нужны, программа обновляется на любом компьютере.
    let mut urls = Vec::new();
    for u in [
        format!("https://github.com/{repo}/releases/latest/download/latest.json"),
        format!("https://raw.githubusercontent.com/{repo}/main/updates/latest.json"),
    ] {
        urls.push(u.parse::<tauri::Url>().map_err(e)?);
    }
    app.updater_builder().pubkey(key).endpoints(urls).map_err(e)?.build().map_err(e)
}

#[tauri::command]
async fn check_update(app: AppHandle, m: State<'_, Arc<Monitor>>) -> R<Option<UpdateInfo>> {
    let u = updater(&app, &m)?;
    match u.check().await {
        Ok(Some(up)) => Ok(Some(UpdateInfo {
            version: up.version.clone(),
            current: up.current_version.clone(),
            notes: up.body.clone(),
            date: up.date.map(|d| d.to_string()),
        })),
        Ok(None) => Ok(None),
        Err(err) => Err(format!("не удалось проверить обновления: {err}")),
    }
}

#[tauri::command]
async fn install_update(app: AppHandle, m: State<'_, Arc<Monitor>>) -> R<()> {
    let u = updater(&app, &m)?;
    let Some(up) = u.check().await.map_err(e)? else {
        return Err("обновлений нет".into());
    };
    up.download_and_install(|_, _| {}, || {}).await.map_err(|err| format!("не удалось установить обновление: {err}"))?;
    app.restart();
}

fn spawn_update_checker(app: AppHandle, m: Arc<Monitor>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        let mut announced: Option<String> = None;
        loop {
            if m.settings().auto_update {
                if let Ok(u) = updater(&app, &m) {
                    if let Ok(Some(up)) = u.check().await {
                        if announced.as_deref() != Some(up.version.as_str()) {
                            announced = Some(up.version.clone());
                            let _ = app.emit(
                                "update-available",
                                UpdateInfo { version: up.version.clone(), current: up.current_version.clone(), notes: up.body.clone(), date: None },
                            );
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
        }
    });
}

// ---------------------------------------------------------------- трей

const TRAY_OK: &[u8] = include_bytes!("../icons/tray-ok.png");
const TRAY_BAD: &[u8] = include_bytes!("../icons/tray-bad.png");

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть NetPulse", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(TRAY_OK)?)
        .tooltip("NetPulse")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn spawn_tray_updater(app: AppHandle, m: Arc<Monitor>) {
    tauri::async_runtime::spawn(async move {
        let mut last_bad: Option<usize> = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let s = m.summaries();
            let bad: Vec<&TargetSummary> = s.iter().filter(|x| matches!(x.health, Health::Down | Health::Crit)).collect();
            if last_bad == Some(bad.len()) {
                continue;
            }
            last_bad = Some(bad.len());
            if let Some(tray) = app.tray_by_id("main") {
                let tip = if bad.is_empty() {
                    format!("NetPulse — всё в порядке ({} целей)", s.len())
                } else {
                    let names: Vec<&str> = bad.iter().take(5).map(|x| x.name.as_str()).collect();
                    format!("NetPulse — проблемы: {}\n{}", bad.len(), names.join("\n"))
                };
                let _ = tray.set_tooltip(Some(tip));
                let icon = if bad.is_empty() { TRAY_OK } else { TRAY_BAD };
                if let Ok(img) = Image::from_bytes(icon) {
                    let _ = tray.set_icon(Some(img));
                }
            }
        }
    });
}

fn spawn_alert_listener(app: AppHandle, m: Arc<Monitor>) {
    let mut rx = m.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(alert) => {
                    let ch = m.settings().channels;
                    if alert.notify && ch.system {
                        let _ = app.notification().builder().title("NetPulse").body(&alert.message).show();
                    }
                    let _ = app.emit("alert", serde_json::json!({ "alert": alert, "sound": ch.sound && alert.notify }));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    });
}

// ---------------------------------------------------------------- запуск

/// Меню приложения macOS: без системного подменю «Службы» (Services).
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, PredefinedMenuItem, Submenu};
    let about = AboutMetadata {
        name: Some("NetPulse".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        authors: Some(vec![AUTHOR.into()]),
        comments: Some("Мониторинг доступности сервисов".into()),
        copyright: Some(format!("© 2026 {AUTHOR}")),
        credits: Some(format!("Автор: {AUTHOR}")),
        ..Default::default()
    };
    let app_sub = Submenu::with_items(
        app,
        "NetPulse",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("О программе NetPulse"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Скрыть NetPulse"))?,
            &PredefinedMenuItem::hide_others(app, Some("Скрыть остальные"))?,
            &PredefinedMenuItem::show_all(app, Some("Показать все"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Завершить NetPulse"))?,
        ],
    )?;
    // «Правка» нужна, чтобы в полях ввода работали ⌘C / ⌘V / ⌘X / ⌘A / ⌘Z.
    let edit_sub = Submenu::with_items(
        app,
        "Правка",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Отменить"))?,
            &PredefinedMenuItem::redo(app, Some("Повторить"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Вырезать"))?,
            &PredefinedMenuItem::copy(app, Some("Копировать"))?,
            &PredefinedMenuItem::paste(app, Some("Вставить"))?,
            &PredefinedMenuItem::select_all(app, Some("Выбрать всё"))?,
        ],
    )?;
    let window_sub = Submenu::with_items(
        app,
        "Окно",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("Свернуть"))?,
            &PredefinedMenuItem::maximize(app, Some("Развернуть"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("Закрыть окно"))?,
        ],
    )?;
    Menu::with_items(app, &[&app_sub, &edit_sub, &window_sub])
}

pub const AUTHOR: &str = "Sorokin Maksim";

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    let app = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            netpulse_core::logging::init(&dir, std::env::args().any(|a| a == "--verbose"));
            let monitor = match tauri::async_runtime::block_on(async { Monitor::start(&dir) }) {
                Ok(m) => m,
                Err(err) => {
                    // Понятное окно вместо молчаливого выхода.
                    log::error!("не удалось запустить движок: {err}");
                    let text = format!(
                        "Не удалось запустить NetPulse.\n\n{err}\n\nДанные лежат в папке:\n{}\n\nЕсли повреждён файл базы netpulse.db, переименуйте или удалите его — программа создаст новый, но история будет потеряна.",
                        dir.display()
                    );
                    app.dialog().message(text).title("NetPulse: ошибка запуска").kind(MessageDialogKind::Error).blocking_show();
                    return Err(Box::<dyn std::error::Error>::from(err.to_string()));
                }
            };
            app.manage(monitor.clone());
            setup_tray(app.handle())?;
            spawn_tray_updater(app.handle().clone(), monitor.clone());
            spawn_update_checker(app.handle().clone(), monitor.clone());
            spawn_alert_listener(app.handle().clone(), monitor);
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let to_tray = window
                    .app_handle()
                    .try_state::<Arc<Monitor>>()
                    .map_or(true, |m| m.settings().minimize_to_tray);
                if to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine_info,
            list_targets,
            save_target,
            save_targets,
            delete_target,
            set_target_enabled,
            reorder_targets,
            get_summaries,
            list_groups,
            add_group,
            rename_group,
            delete_group,
            move_to_group,
            set_template_targets,
            read_log,
            get_topology,
            get_map_layout,
            save_map_layout,
            get_diagnosis,
            reorder_groups,
            get_trace,
            get_timeline,
            get_timelines,
            get_uptime,
            get_events,
            clear_events,
            clear_history,
            history_stats,
            get_settings,
            save_settings,
            test_channel,
            test_system_notification,
            export_csv,
            export_config,
            import_config,
            check_update,
            install_update,
            update_source,
            project_page,
            open_project_page,
            find_duplicates,
            merge_duplicates,
            get_report,
            export_report,
            get_heatmap,
            get_hop_timelines,
        ])
        .build(tauri::generate_context!())
        .expect("не удалось запустить NetPulse");

    app.run(|_app, _event| {
        // macOS: клик по иконке в Dock открывает скрытое окно.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            show_main(_app);
        }
    });
}
