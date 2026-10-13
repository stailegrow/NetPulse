//! NetPulse — движок мониторинга: трассировка, проверки, статистика, хранилище, алерты.
//! Не зависит от UI: используется Tauri-приложением и CLI.

pub mod alerts;
pub mod analyze;
pub mod checks;
pub mod incidents;
pub mod license;
pub mod logging;
pub mod model;
pub mod monitor;
pub mod scan;
pub mod stats;
pub mod storage;
pub mod telegram;

pub use monitor::{EngineInfo, Monitor};
pub use netpulse_icmp as icmp;
