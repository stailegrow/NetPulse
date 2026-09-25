//! Простой файловый журнал приложения: netpulse.log рядом с базой данных.
//! Нужен, чтобы разбираться в проблемах у пользователя: ошибки записи в базу,
//! сбои отправки уведомлений, недоступность ICMP, паники.

use parking_lot::Mutex;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 2 * 1024 * 1024;

struct FileLogger {
    path: PathBuf,
    file: Mutex<Option<File>>,
    level: log::LevelFilter,
}

impl FileLogger {
    fn rotate_if_needed(&self, f: &mut File) {
        if f.metadata().map(|m| m.len()).unwrap_or(0) < MAX_BYTES {
            return;
        }
        let old = self.path.with_extension("log.1");
        let _ = std::fs::remove_file(&old);
        let _ = std::fs::rename(&self.path, &old);
        if let Ok(nf) = OpenOptions::new().create(true).append(true).open(&self.path) {
            *f = nf;
        }
    }
}

impl log::Log for FileLogger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= self.level
    }

    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let line = format!(
            "{} {:5} [{}] {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            r.level(),
            r.target(),
            r.args()
        );
        let mut guard = self.file.lock();
        if guard.is_none() {
            *guard = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        }
        if let Some(f) = guard.as_mut() {
            self.rotate_if_needed(f);
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
        // В отладочной сборке дублируем в консоль.
        #[cfg(debug_assertions)]
        eprint!("{line}");
    }

    fn flush(&self) {
        if let Some(f) = self.file.lock().as_mut() {
            let _ = f.flush();
        }
    }
}

/// Путь к файлу журнала.
pub fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("netpulse.log")
}

/// Включает запись журнала в файл. Вызывается один раз при старте.
pub fn init(data_dir: &Path, verbose: bool) -> PathBuf {
    let path = log_path(data_dir);
    let _ = std::fs::create_dir_all(data_dir);
    let level = if verbose { log::LevelFilter::Debug } else { log::LevelFilter::Info };
    // Логгер живёт до конца работы программы, поэтому статическая ссылка уместна.
    let logger: &'static FileLogger = Box::leak(Box::new(FileLogger { path: path.clone(), file: Mutex::new(None), level }));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(level);
    }
    // Паники тоже должны попадать в журнал, иначе окно просто закрывается без следов.
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("паника: {info}");
        default(info);
    }));
    log::info!("NetPulse {} запущен, журнал: {}", env!("CARGO_PKG_VERSION"), path.display());
    path
}

/// Последние строки журнала — для показа в настройках.
pub fn tail(data_dir: &Path, lines: usize) -> String {
    let path = log_path(data_dir);
    let Ok(data) = std::fs::read_to_string(&path) else { return String::new() };
    let all: Vec<&str> = data.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}
