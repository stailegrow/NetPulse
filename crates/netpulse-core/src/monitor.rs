use crate::alerts::{self, Alert, AlertState};
use crate::analyze::{self, Diagnosis};
use crate::checks::{self, now_ms};
use crate::model::*;
use crate::stats;
use crate::storage::Storage;
use anyhow::{anyhow, Result};
use netpulse_icmp::Pinger;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

/// Как часто уточнять маршрут для карты у целей без трассировки.
const MAP_ROUTE_EVERY_MS: i64 = 20 * 60_000;
/// Сколько таких трассировок за один проход фоновой задачи (по 3 одновременно).
const MAP_ROUTE_BATCH: usize = 9;
/// Сколько сэмплов держим в памяти на цель (при 2.5 с ≈ 2.5 часа).
const RECENT_CAP: usize = 3600;
pub const DEFAULT_GROUP: &str = "Общее";
const RESOLVE_EVERY_MS: i64 = 5 * 60_000;
const CERT_EVERY_MS: i64 = 6 * 3_600_000;
/// Минимальная длительность недоступности, которая попадает в события цели.
pub const MIN_OUTAGE_MS: i64 = 5_000;
/// Сколько показывать шильдик «сменился маршрут».
pub const ROUTE_BADGE_MS: i64 = 30 * 60_000;
/// Сколько раундов подряд новый маршрут должен повториться, чтобы считаться сменой.
const ROUTE_CONFIRM_ROUNDS: u32 = 3;
/// После запуска проверки маршрут не сравниваем: первые раунды трассировки при старте
/// всех целей сразу часто неполные (ICMP rate-limit у маршрутизаторов) — ложные «смены».
pub const ROUTE_WARMUP_MS: i64 = 60_000;

#[derive(Default)]
struct RunState {
    recent: VecDeque<Sample>,
    resolved: Option<IpAddr>,
    resolved_at: i64,
    resolve_error: Option<String>,
    dest_ttl: Option<u8>,
    unreached_streak: u32,
    route: Vec<Option<IpAddr>>,
    candidate_route: Vec<Option<IpAddr>>,
    candidate_hits: u32,
    route_changed_at: Option<i64>,
    /// Когда запущена проверка (для прогрева сравнения маршрута).
    started_at: i64,
    route_change_msg: Option<String>,
    /// Время первого потерянного сэмпла текущей недоступности.
    outage_start: Option<i64>,
    /// Последний ответ DNS-сервера (для DNS-целей).
    dns_answer: Option<String>,
    /// Смена IP при резолве: когда и что изменилось.
    ip_changed_at: Option<i64>,
    ip_change_msg: Option<String>,
    /// Кэш короткой причины: время расчёта и результат.
    cause_at: i64,
    cause: Option<String>,
    /// Состояние, показанное в прошлый раз, и момент, когда оно установилось.
    health_seen: Option<Health>,
    health_since: i64,
    /// Маршрут для карты сети у целей без трассировки: хопы, задержки, когда и дошли ли.
    map_route: Vec<Option<IpAddr>>,
    map_rtts: Vec<Option<f32>>,
    map_route_at: i64,
    map_reached: bool,
    /// Во время аварии: сколько хопов ещё отвечают и когда это проверено.
    /// Сам маршрут не трогаем — карта не должна перестраиваться из-за сбоя.
    map_reach: Option<usize>,
    map_check_at: i64,
    /// Падение цели было «тихим» из-за недоступного родителя — восстановление тоже без уведомления.
    suppressed_by_parent: bool,
    alert: AlertState,
    cert_days: Option<i64>,
    cert_checked: i64,
    http_client: Option<reqwest::Client>,
}

struct Runner {
    target: RwLock<Target>,
    state: Mutex<RunState>,
    task: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub icmp_mode: Option<String>,
    pub icmp_error: Option<String>,
    pub supports_trace: bool,
    pub version: String,
    pub data_dir: String,
    /// Путь к файлу журнала работы программы.
    pub log_path: String,
    /// Сообщение о восстановлении после повреждённой базы.
    pub db_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStats {
    pub samples: i64,
    pub rollups: i64,
    pub events: i64,
    pub db_bytes: i64,
}

pub struct Monitor {
    /// Хэндл tokio-рантайма: команды UI вызываются из главного потока, где
    /// рантайма нет, поэтому все фоновые задачи запускаем через него.
    rt: tokio::runtime::Handle,
    storage: Arc<Storage>,
    pinger: Option<Pinger>,
    pinger_error: Option<String>,
    settings: RwLock<Settings>,
    /// Список групп в порядке пользователя (группы могут быть пустыми).
    groups: RwLock<Vec<String>>,
    order: RwLock<Vec<String>>,
    runners: RwLock<HashMap<String, Arc<Runner>>>,
    alerts_tx: broadcast::Sender<Alert>,
    dns: Mutex<HashMap<IpAddr, Option<String>>>,
    dns_pending: Mutex<HashSet<IpAddr>>,
    data_dir: String,
    /// Буфер проверок: пишем в базу пачками, а не по одной.
    write_buf: Mutex<Vec<(String, Sample)>>,
    /// Сообщение о восстановлении после повреждённой базы — показываем в интерфейсе.
    db_warning: RwLock<Option<String>>,
}

impl Monitor {
    /// Запуск движка. Вызывать внутри tokio runtime.
    pub fn start(data_dir: &Path) -> Result<Arc<Self>> {
        let (storage, warning) = Storage::open(&data_dir.join("netpulse.db"))?;
        let m = Self::start_with_storage(Arc::new(storage), data_dir.display().to_string())?;
        if let Some(w) = warning {
            *m.db_warning.write() = Some(w);
        }
        Ok(m)
    }

    pub fn start_with_storage(storage: Arc<Storage>, data_dir: String) -> Result<Arc<Self>> {
        let settings = storage.load_settings()?;
        let targets = storage.load_targets()?;
        let mut groups = storage.load_groups()?;
        for t in &targets {
            if !groups.iter().any(|g| g == &t.group) {
                groups.push(t.group.clone());
            }
        }
        // «Общее» — системная группа по умолчанию, всегда первая.
        groups.retain(|g| g != DEFAULT_GROUP);
        groups.insert(0, DEFAULT_GROUP.to_string());
        storage.save_groups(&groups)?;
        let (pinger, pinger_error) = match Pinger::new() {
            Ok(p) => (Some(p), None),
            Err(e) => {
                log::error!("ICMP недоступен: {e}");
                (None, Some(e.to_string()))
            }
        };
        let (alerts_tx, _) = broadcast::channel(256);
        let rt = tokio::runtime::Handle::try_current()
            .map_err(|_| anyhow!("Monitor::start нужно вызывать внутри tokio runtime"))?;
        let m = Arc::new(Self {
            rt: rt.clone(),
            storage,
            pinger,
            pinger_error,
            settings: RwLock::new(settings),
            groups: RwLock::new(groups),
            order: RwLock::new(Vec::new()),
            runners: RwLock::new(HashMap::new()),
            alerts_tx,
            dns: Mutex::new(HashMap::new()),
            write_buf: Mutex::new(Vec::new()),
            db_warning: RwLock::new(None),
            dns_pending: Mutex::new(HashSet::new()),
            data_dir,
        });
        let now = now_ms();
        for mut t in targets {
            let norm = t.thresholds.normalized_for(t.kind);
            if norm != t.thresholds {
                t.thresholds = norm;
                let _ = m.storage.save_target(&t, m.order.read().len() as i64);
            }
            let recent_route = m
                .storage
                .events(50, Some(&t.id))
                .ok()
                .and_then(|ev| ev.into_iter().find(|e| e.kind == "route" && now - e.ts < ROUTE_BADGE_MS))
                .filter(|_| t.kind == CheckKind::Trace);
            let id = t.id.clone();
            m.add_runner(t);
            if let (Some(ev), Some(r)) = (recent_route, m.runners.read().get(&id)) {
                let mut st = r.state.lock();
                st.route_changed_at = Some(ev.ts);
                st.route_change_msg = Some(ev.message.split(" — ").nth(1).unwrap_or(&ev.message).to_string());
            }
        }
        {
            let mut s = m.settings.write();
            let norm = s.default_thresholds.normalized();
            if norm != s.default_thresholds {
                s.default_thresholds = norm;
                let _ = m.storage.save_settings(&s);
            }
        }
        // Маршруты для карты сети: у целей без трассировки путь узнаём фоновой трассировкой.
        let weak_r = Arc::downgrade(&m);
        rt.spawn(async move {
            tokio::time::sleep(Duration::from_secs(15)).await;
            loop {
                let Some(m) = weak_r.upgrade() else { return };
                m.discover_routes().await;
                drop(m);
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        });
        // Сброс буфера проверок в базу раз в секунду.
        let weak_w = Arc::downgrade(&m);
        rt.spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(1000)).await;
                let Some(m) = weak_w.upgrade() else { return };
                m.flush_samples().await;
            }
        });
        let weak = Arc::downgrade(&m);
        rt.spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            loop {
                let Some(m) = weak.upgrade() else { return };
                let s = m.settings.read().clone();
                let st = m.storage.clone();
                let _ = tokio::task::spawn_blocking(move || st.maintenance(&s, now_ms())).await;
                drop(m);
                tokio::time::sleep(Duration::from_secs(120)).await;
            }
        });
        Ok(m)
    }

    /// Записывает накопленные проверки одной транзакцией.
    async fn flush_samples(&self) {
        let batch: Vec<(String, Sample)> = {
            let mut buf = self.write_buf.lock();
            if buf.is_empty() {
                return;
            }
            std::mem::take(&mut *buf)
        };
        let n = batch.len();
        let storage = self.storage.clone();
        let res = tokio::task::spawn_blocking(move || storage.insert_samples(&batch)).await;
        match res {
            Ok(Err(e)) => log::error!("не удалось записать {n} проверок в базу: {e}"),
            Err(e) => log::error!("задача записи проверок упала: {e}"),
            _ => {}
        }
    }

    /// Предупреждение о повреждённой базе (если оно было при запуске).
    pub fn db_warning(&self) -> Option<String> {
        self.db_warning.read().clone()
    }

    pub fn engine_info(&self) -> EngineInfo {
        EngineInfo {
            icmp_mode: self.pinger.as_ref().map(|p| p.mode()),
            icmp_error: self.pinger_error.clone(),
            supports_trace: self.pinger.as_ref().map_or(false, |p| p.supports_trace()),
            version: env!("CARGO_PKG_VERSION").into(),
            data_dir: self.data_dir.clone(),
            log_path: crate::logging::log_path(Path::new(&self.data_dir)).display().to_string(),
            db_warning: self.db_warning(),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Alert> {
        self.alerts_tx.subscribe()
    }

    // ------------------------------------------------------------ targets

    fn add_runner(self: &Arc<Self>, t: Target) {
        let id = t.id.clone();
        let runner = Arc::new(Runner { target: RwLock::new(t), state: Mutex::new(RunState::default()), task: Mutex::new(None) });
        self.runners.write().insert(id.clone(), runner.clone());
        if !self.order.read().contains(&id) {
            self.order.write().push(id);
        }
        self.spawn(runner);
    }

    fn spawn(self: &Arc<Self>, runner: Arc<Runner>) {
        // Один захват на всё время замены: иначе два параллельных upsert оставят два цикла проверок.
        let mut slot = runner.task.lock();
        if let Some(h) = slot.take() {
            h.abort();
        }
        let t = runner.target.read().clone();
        if !t.enabled {
            return;
        }
        runner.state.lock().started_at = now_ms();
        let weak = Arc::downgrade(self);
        let r = runner.clone();
        let handle = self.rt.spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(t.interval_ms.max(500)));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(m) = weak.upgrade() else { return };
                m.run_once(&r).await;
            }
        });
        *slot = Some(handle);
    }

    pub fn list_targets(&self) -> Vec<Target> {
        let runners = self.runners.read();
        self.order.read().iter().filter_map(|id| runners.get(id).map(|r| r.target.read().clone())).collect()
    }

    pub fn upsert_target(self: &Arc<Self>, mut t: Target) -> Result<Target> {
        t.host = t.host.trim().to_string();
        if t.host.is_empty() {
            return Err(anyhow!("укажите адрес"));
        }
        if t.kind == CheckKind::Tcp && t.port.is_none() {
            return Err(anyhow!("для TCP-проверки нужен порт"));
        }
        if t.name.trim().is_empty() {
            t.name = t.host.clone();
        }
        if t.group.trim().is_empty() {
            t.group = DEFAULT_GROUP.into();
        }
        t.group = t.group.trim().to_string();
        self.ensure_group(&t.group)?;
        t.interval_ms = t.interval_ms.clamp(500, 3_600_000);
        t.timeout_ms = t.timeout_ms.clamp(200, 60_000);
        t.max_hops = t.max_hops.clamp(1, 64);
        t.packet_size = t.packet_size.clamp(0, 1472);
        if t.id.is_empty() {
            t.id = uuid::Uuid::new_v4().to_string();
        }
        if t.parent_id.as_deref().map_or(false, |p| p.is_empty()) {
            t.parent_id = None;
        }
        self.apply_template(&mut t);
        if let Some(p) = t.parent_id.clone() {
            if p == t.id {
                return Err(anyhow!("цель не может зависеть сама от себя"));
            }
            // Не допускаем циклов: идём вверх по цепочке родителей.
            let mut cur = Some(p);
            let mut depth = 0;
            while let Some(c) = cur {
                if c == t.id {
                    return Err(anyhow!("зависимость по кругу: родитель уже зависит от этой цели"));
                }
                depth += 1;
                if depth > 32 {
                    break;
                }
                cur = self.runners.read().get(&c).and_then(|r| r.target.read().parent_id.clone());
            }
        }
        let pos = {
            let order = self.order.read();
            order.iter().position(|x| *x == t.id).unwrap_or(order.len()) as i64
        };
        self.storage.save_target(&t, pos)?;
        let existing = self.runners.read().get(&t.id).cloned();
        match existing {
            Some(r) => {
                let old = r.target.read().clone();
                *r.target.write() = t.clone();
                if old.host != t.host || old.kind != t.kind || old.http != t.http || old.dns != t.dns {
                    *r.state.lock() = RunState::default();
                } else {
                    r.state.lock().http_client = None;
                }
                self.spawn(r);
            }
            None => self.add_runner(t.clone()),
        }
        Ok(t)
    }

    // ------------------------------------------------------------ groups

    pub fn groups(&self) -> Vec<String> {
        self.groups.read().clone()
    }

    fn ensure_group(&self, name: &str) -> Result<()> {
        if self.groups.read().iter().any(|g| g == name) {
            return Ok(());
        }
        let mut g = self.groups.write();
        g.push(name.to_string());
        self.storage.save_groups(&g)
    }

    fn clean_group_name(name: &str) -> Result<String> {
        let n = name.trim();
        if n.is_empty() {
            return Err(anyhow!("введите название группы"));
        }
        if n.chars().count() > 60 {
            return Err(anyhow!("слишком длинное название (максимум 60 символов)"));
        }
        Ok(n.to_string())
    }

    pub fn add_group(&self, name: &str) -> Result<String> {
        let n = Self::clean_group_name(name)?;
        if self.groups.read().iter().any(|g| g.to_lowercase() == n.to_lowercase()) {
            return Err(anyhow!("группа «{n}» уже есть"));
        }
        self.ensure_group(&n)?;
        Ok(n)
    }

    /// Переименование. Если группа с новым именем уже есть — цели объединяются в неё.
    pub fn rename_group(&self, old: &str, new: &str) -> Result<String> {
        let n = Self::clean_group_name(new)?;
        if old == DEFAULT_GROUP {
            return Err(anyhow!("«{DEFAULT_GROUP}» — группа по умолчанию, её нельзя переименовать"));
        }
        if !self.groups.read().iter().any(|g| g == old) {
            return Err(anyhow!("группа «{old}» не найдена"));
        }
        if n == old {
            return Ok(n);
        }
        let ids: Vec<String> = self.list_targets().into_iter().filter(|t| t.group == old).map(|t| t.id).collect();
        {
            let mut g = self.groups.write();
            let exists = g.iter().any(|x| x == &n);
            if exists {
                g.retain(|x| x != old);
            } else if let Some(x) = g.iter_mut().find(|x| x.as_str() == old) {
                *x = n.clone();
            }
            self.storage.save_groups(&g)?;
        }
        self.move_targets(&ids, &n)?;
        {
            let mut st = self.settings.write();
            let mut changed = false;
            for tp in st.templates.iter_mut() {
                for g in tp.groups.iter_mut() {
                    if g == old {
                        *g = n.clone();
                        changed = true;
                    }
                }
                tp.groups.dedup();
            }
            if changed {
                self.storage.save_settings(&st)?;
            }
        }
        Ok(n)
    }

    /// Удаление группы: цели переносятся в `move_to` или удаляются (если `move_to` = None).
    pub fn delete_group(&self, name: &str, move_to: Option<&str>) -> Result<()> {
        if name == DEFAULT_GROUP {
            return Err(anyhow!("«{DEFAULT_GROUP}» — группа по умолчанию, её нельзя удалить"));
        }
        let ids: Vec<String> = self.list_targets().into_iter().filter(|t| t.group == name).map(|t| t.id).collect();
        match move_to {
            Some(dest) => {
                let dest = Self::clean_group_name(dest)?;
                if dest == name {
                    return Err(anyhow!("нельзя перенести цели в удаляемую группу"));
                }
                self.ensure_group(&dest)?;
                self.move_targets(&ids, &dest)?;
            }
            None => {
                for id in &ids {
                    self.delete_target(id)?;
                }
            }
        }
        {
            let mut st = self.settings.write();
            if st.templates.iter().any(|tp| tp.groups.iter().any(|g| g == name)) {
                for tp in st.templates.iter_mut() {
                    tp.groups.retain(|g| g != name);
                }
                self.storage.save_settings(&st)?;
            }
        }
        let mut g = self.groups.write();
        g.retain(|x| x != name);
        self.storage.save_groups(&g)
    }

    /// Перенос целей в группу без перезапуска проверок.
    pub fn move_targets(&self, ids: &[String], group: &str) -> Result<usize> {
        let group = Self::clean_group_name(group)?;
        self.ensure_group(&group)?;
        let order = self.order.read().clone();
        let runners = self.runners.read();
        let mut n = 0;
        for id in ids {
            if let Some(r) = runners.get(id) {
                let t = {
                    let mut t = r.target.write();
                    t.group = group.clone();
                    t.clone()
                };
                let pos = order.iter().position(|x| x == id).unwrap_or(order.len()) as i64;
                self.storage.save_target(&t, pos)?;
                n += 1;
            }
        }
        Ok(n)
    }

    pub fn reorder_groups(&self, names: Vec<String>) -> Result<()> {
        let mut g = self.groups.write();
        let mut next: Vec<String> = vec![DEFAULT_GROUP.to_string()];
        next.extend(names.into_iter().filter(|n| g.contains(n) && n != DEFAULT_GROUP));
        for x in g.iter() {
            if !next.contains(x) {
                next.push(x.clone());
            }
        }
        *g = next;
        self.storage.save_groups(&g)
    }

    pub fn delete_target(&self, id: &str) -> Result<()> {
        // Дочерние цели перестают зависеть от удаляемой.
        let order = self.order.read().clone();
        for (i, oid) in order.iter().enumerate() {
            if let Some(r) = self.runners.read().get(oid) {
                let mut t = r.target.write();
                if t.parent_id.as_deref() == Some(id) {
                    t.parent_id = None;
                    self.storage.save_target(&t, i as i64)?;
                }
            }
        }
        if let Some(r) = self.runners.write().remove(id) {
            if let Some(h) = r.task.lock().take() {
                h.abort();
            }
        }
        self.order.write().retain(|x| x != id);
        self.storage.delete_target(id)
    }

    pub fn set_enabled(self: &Arc<Self>, id: &str, enabled: bool) -> Result<()> {
        let r = self.runners.read().get(id).cloned().ok_or_else(|| anyhow!("цель не найдена"))?;
        let mut t = r.target.read().clone();
        t.enabled = enabled;
        self.upsert_target(t).map(|_| ())
    }

    pub fn reorder(&self, ids: Vec<String>) -> Result<()> {
        let runners = self.runners.read();
        for (i, id) in ids.iter().enumerate() {
            if let Some(r) = runners.get(id) {
                self.storage.save_target(&r.target.read(), i as i64)?;
            }
        }
        *self.order.write() = ids.into_iter().filter(|id| runners.contains_key(id)).collect();
        Ok(())
    }

    // ------------------------------------------------------------ settings

    pub fn settings(&self) -> Settings {
        self.settings.read().clone()
    }

    pub fn save_settings(self: &Arc<Self>, mut s: Settings) -> Result<()> {
        // Группа может быть закреплена только за одним шаблоном: побеждает последний в списке.
        let mut seen = std::collections::HashSet::new();
        for tp in s.templates.iter_mut().rev() {
            tp.groups.retain(|g| !g.trim().is_empty() && seen.insert(g.clone()));
        }
        self.storage.save_settings(&s)?;
        *self.settings.write() = s;
        self.sync_templates()?;
        Ok(())
    }

    /// Подставляет в цель значения её шаблона; если шаблон удалён — отвязывает.
    fn apply_template(&self, t: &mut Target) {
        if t.template_id.as_deref().map_or(false, |x| x.is_empty()) {
            t.template_id = None;
        }
        if let Some(id) = t.template_id.clone() {
            let s = self.settings.read();
            match s.templates.iter().find(|x| x.id == id) {
                Some(tp) => {
                    tp.apply_to(t);
                }
                None => t.template_id = None,
            }
        }
    }

    /// Шаблон, закреплённый за группой.
    pub fn group_template(&self, group: &str) -> Option<String> {
        self.settings.read().templates.iter().find(|tp| tp.groups.iter().any(|g| g == group)).map(|tp| tp.id.clone())
    }

    /// После изменения шаблонов — обновить все привязанные цели.
    fn sync_templates(self: &Arc<Self>) -> Result<usize> {
        let mut n = 0;
        for t in self.list_targets() {
            if t.template_id.is_none() {
                continue;
            }
            let mut x = t.clone();
            self.apply_template(&mut x);
            if x != t {
                self.upsert_target(x)?;
                n += 1;
            }
        }
        Ok(n)
    }

    /// Привязать к шаблону ровно этот набор целей: остальные цели этого шаблона отвязываются
    /// (их текущие значения остаются).
    pub fn set_template_targets(self: &Arc<Self>, template_id: &str, ids: &[String]) -> Result<usize> {
        if !self.settings.read().templates.iter().any(|x| x.id == template_id) {
            return Err(anyhow!("шаблон не найден"));
        }
        let mut n = 0;
        for t in self.list_targets() {
            let want = ids.contains(&t.id);
            let has = t.template_id.as_deref() == Some(template_id);
            if want == has {
                continue;
            }
            let mut x = t.clone();
            x.template_id = if want { Some(template_id.to_string()) } else { None };
            self.upsert_target(x)?;
            n += 1;
        }
        Ok(n)
    }

    /// Цели без шаблона, попавшие в группу с закреплённым шаблоном, получают его.
    pub fn apply_group_templates(self: &Arc<Self>, ids: &[String]) -> Result<usize> {
        let mut n = 0;
        for t in self.list_targets() {
            if !ids.contains(&t.id) || t.template_id.is_some() {
                continue;
            }
            if let Some(tp) = self.group_template(&t.group) {
                let mut x = t.clone();
                x.template_id = Some(tp);
                self.upsert_target(x)?;
                n += 1;
            }
        }
        Ok(n)
    }

    pub async fn test_channel(&self, name: &str) -> Result<()> {
        let ch = self.settings.read().channels.clone();
        alerts::test_channel(&ch, name).await
    }

    // ------------------------------------------------------------ probe loop

    async fn run_once(self: &Arc<Self>, r: &Arc<Runner>) {
        let t = r.target.read().clone();
        let timeout = Duration::from_millis(t.timeout_ms);
        let now = now_ms();

        let sample = match t.kind {
            CheckKind::Trace | CheckKind::Ping => match self.resolve_for(r, &t, now).await {
                Err(e) => Sample { ts: now, rtt_ms: None, status_code: None, error: Some(e), hops: vec![] },
                Ok(ip) => match &self.pinger {
                    None => Sample {
                        ts: now,
                        rtt_ms: None,
                        status_code: None,
                        error: Some(format!("ICMP недоступен: {}", self.pinger_error.clone().unwrap_or_default())),
                        hops: vec![],
                    },
                    Some(p) if t.kind == CheckKind::Trace && p.supports_trace() => self.trace(r, &t, p, ip, timeout).await,
                    Some(p) => {
                        checks::ping_once(p, ip, t.packet_size, timeout).await
                    }
                },
            },
            CheckKind::Http => {
                let client = {
                    let mut st = r.state.lock();
                    if st.http_client.is_none() {
                        st.http_client = checks::http_client(&t.http, timeout).ok();
                    }
                    st.http_client.clone()
                };
                let s = match client {
                    Some(c) => checks::http_check(&c, &t).await,
                    None => Sample { ts: now, rtt_ms: None, status_code: None, error: Some("не удалось создать HTTP-клиент".into()), hops: vec![] },
                };
                self.maybe_check_cert(r, &t, now);
                s
            }
            CheckKind::Tcp => checks::tcp_check(&t.host, t.port.unwrap_or(80), timeout).await,
            CheckKind::Dns => {
                let (s, answer) = checks::dns_check(&t, timeout).await;
                if answer.is_some() {
                    r.state.lock().dns_answer = answer;
                }
                s
            }
        };

        // Цель могла быть удалена/изменена во время проверки.
        if !self.runners.read().contains_key(&t.id) {
            return;
        }
        // Запись в базу — пакетами: фоновая задача сбрасывает буфер раз в секунду.
        self.write_buf.lock().push((t.id.clone(), sample.clone()));

        let rules = self.settings.read().alert_rules.clone();
        let outage = if matches!(t.kind, CheckKind::Ping | CheckKind::Trace) { self.track_outage(r, &sample) } else { None };
        let fired = {
            let mut st = r.state.lock();
            st.recent.push_back(sample);
            // Держим в памяти около 30 минут истории, но не больше лимита: у трассировок
            // каждый сэмпл несёт список хопов.
            let cap = ((30 * 60_000 / t.interval_ms.max(500)) as usize).clamp(240, RECENT_CAP);
            while st.recent.len() > cap {
                st.recent.pop_front();
            }
            let RunState { alert, recent, .. } = &mut *st;
            alerts::evaluate(alert, &t, &rules, recent, now)
        };
        for a in fired {
            self.emit(a);
        }
        if let Some((start, end)) = outage {
            let name = if t.name.is_empty() { t.host.clone() } else { t.name.clone() };
            self.emit(Alert {
                target_id: t.id.clone(),
                target_name: t.name.clone(),
                kind: "outage".into(),
                severity: "critical".into(),
                message: format!("⛔ {name}: узел был недоступен с {} по {} ({})", fmt_clock(start), fmt_clock(end), fmt_duration(end - start)),
                notify: false,
                silent: false,
            });
        }
    }

    /// Отслеживает интервалы недоступности. Возвращает (начало, конец), когда узел снова ответил
    /// и простой длился не меньше MIN_OUTAGE_MS.
    fn track_outage(&self, r: &Runner, s: &Sample) -> Option<(i64, i64)> {
        let mut st = r.state.lock();
        match (s.rtt_ms, st.outage_start) {
            (None, None) => {
                st.outage_start = Some(s.ts);
                None
            }
            (Some(_), Some(start)) => {
                st.outage_start = None;
                (s.ts - start >= MIN_OUTAGE_MS).then_some((start, s.ts))
            }
            _ => None,
        }
    }

    async fn resolve_for(&self, r: &Runner, t: &Target, now: i64) -> Result<IpAddr, String> {
        let cached = {
            let st = r.state.lock();
            st.resolved.filter(|_| now - st.resolved_at < RESOLVE_EVERY_MS)
        };
        if let Some(ip) = cached {
            return Ok(ip);
        }
        let deadline = Duration::from_millis(t.timeout_ms.max(1000).min(10_000));
        match tokio::time::timeout(deadline, checks::resolve(&t.host)).await.unwrap_or_else(|_| Err(anyhow!("таймаут при определении IP по имени"))) {
            Ok(ip) => {
                let mut st = r.state.lock();
                if let Some(old) = st.resolved {
                    if old != ip {
                        st.dest_ttl = None;
                        st.ip_changed_at = Some(now);
                        st.ip_change_msg = Some(format!("{old} → {ip}"));
                        let msg = format!("🔄 {}: IP изменился {} → {}", t.name, old, ip);
                        drop(st);
                        self.emit(Alert { target_id: t.id.clone(), target_name: t.name.clone(), kind: "dns".into(), severity: "info".into(), message: msg, notify: false, silent: false });
                        st = r.state.lock();
                    }
                }
                st.resolved = Some(ip);
                st.resolved_at = now;
                st.resolve_error = None;
                Ok(ip)
            }
            Err(e) => {
                let mut st = r.state.lock();
                st.resolve_error = Some(e.to_string());
                // Не долбим сломанный DNS каждую проверку: следующая попытка не раньше 30 секунд.
                st.resolved_at = now - RESOLVE_EVERY_MS + 30_000;
                // Используем старый IP, если он был.
                st.resolved.ok_or_else(|| e.to_string())
            }
        }
    }

    async fn trace(self: &Arc<Self>, r: &Runner, t: &Target, p: &Pinger, ip: IpAddr, timeout: Duration) -> Sample {
        let ts = now_ms();
        let max_ttl = r.state.lock().dest_ttl.unwrap_or(t.max_hops).min(t.max_hops);
        let round = checks::trace_round(p, ip, max_ttl, t.packet_size, timeout).await;

        self.track_route(r, t, &round);
        for h in &round.hops {
            if let Some(a) = h.addr {
                self.lookup_name(a);
            }
        }
        let error = if round.reached_ttl.is_none() { Some("цель не ответила".to_string()) } else { None };
        Sample { ts, rtt_ms: round.dest_rtt, status_code: None, error, hops: round.hops }
    }

    /// Обновляет ожидаемую длину маршрута по результату раунда трассировки.
    fn update_dest_ttl(st: &mut RunState, round: &checks::TraceRound) {
        if let Some(n) = round.reached_ttl {
            st.dest_ttl = Some(n);
            st.unreached_streak = 0;
        } else if round.needs_more {
            st.dest_ttl = None;
        } else {
            st.unreached_streak += 1;
            if st.unreached_streak >= 8 {
                st.dest_ttl = None;
                st.unreached_streak = 0;
            }
        }
    }

    /// Отслеживает смену маршрута. Новый маршрут засчитывается, только если повторился
    /// несколько раундов подряд (чтобы не реагировать на разовые отклонения).
    fn track_route(&self, r: &Runner, t: &Target, round: &checks::TraceRound) {
        let msg = {
            let mut st = r.state.lock();
            Self::update_dest_ttl(&mut st, round);
            if round.reached_ttl.is_none() {
                return;
            }
            let route: Vec<Option<IpAddr>> = round.hops.iter().map(|h| h.addr).collect();
            // Раунд, где не ответило больше половины промежуточных хопов, ненадёжен.
            let silent = route.iter().filter(|a| a.is_none()).count();
            if route.len() >= 4 && silent * 2 > route.len() {
                return;
            }
            if now_ms() - st.started_at < ROUTE_WARMUP_MS {
                st.route = route;
                st.candidate_route.clear();
                st.candidate_hits = 0;
                return;
            }
            if st.route.is_empty() {
                st.route = route;
                return;
            }
            if !routes_differ(&st.route, &route) {
                st.candidate_route.clear();
                st.candidate_hits = 0;
                return;
            }
            if st.candidate_route.is_empty() || routes_differ(&st.candidate_route, &route) {
                st.candidate_route = route;
                st.candidate_hits = 1;
                return;
            }
            st.candidate_hits += 1;
            if st.candidate_hits < ROUTE_CONFIRM_ROUNDS {
                return;
            }
            let old = std::mem::take(&mut st.route);
            st.route = std::mem::take(&mut st.candidate_route);
            st.candidate_hits = 0;
            let details = describe_route_change(&old, &st.route);
            st.route_changed_at = Some(now_ms());
            st.route_change_msg = Some(details.clone());
            format!("🔀 {}: сменился маршрут до узла — {}", if t.name.is_empty() { &t.host } else { &t.name }, details)
        };
        let notify = t.alerts_enabled && self.settings.read().alert_rules.route_change_enabled;
        self.emit(Alert { target_id: t.id.clone(), target_name: t.name.clone(), kind: "route".into(), severity: "route".into(), message: msg, notify, silent: false });
    }

    fn maybe_check_cert(self: &Arc<Self>, r: &Arc<Runner>, t: &Target, now: i64) {
        if !checks::normalize_url(&t.host).starts_with("https://") {
            return;
        }
        {
            let mut st = r.state.lock();
            if now - st.cert_checked < CERT_EVERY_MS {
                return;
            }
            st.cert_checked = now;
        }
        let m = self.clone();
        let r = r.clone();
        let t = t.clone();
        self.rt.spawn(async move {
            if let Ok(days) = checks::cert_days_left(&t.host, Duration::from_secs(10)).await {
                let rules = m.settings.read().alert_rules.clone();
                let a = {
                    let mut st = r.state.lock();
                    st.cert_days = Some(days);
                    alerts::evaluate_cert(&mut st.alert, &t, &rules, days, now_ms())
                };
                if let Some(a) = a {
                    m.emit(a);
                }
            }
        });
    }

    /// Адрес цели для трассировки: разрешённый IP или сам адрес, если он уже IP.
    fn target_ip(t: &Target, st: &RunState) -> Option<IpAddr> {
        st.resolved.or_else(|| t.host.trim().parse().ok())
    }

    /// Уточняет маршруты для карты у целей без постоянной трассировки: сначала те,
    /// у кого маршрута ещё нет, потом самые давние. Не больше MAP_ROUTE_BATCH за проход.
    async fn discover_routes(self: &Arc<Self>) {
        let Some(p) = self.pinger.clone() else { return };
        if !p.supports_trace() {
            return;
        }
        let now = now_ms();
        let mut due: Vec<(i64, Arc<Runner>, IpAddr)> = self
            .runners
            .read()
            .values()
            .filter_map(|r| {
                let t = r.target.read();
                if !t.enabled || t.kind == CheckKind::Trace {
                    return None;
                }
                let st = r.state.lock();
                let down = st.alert.down;
                let due = if down { now - st.map_check_at >= 60_000 } else { now - st.map_route_at >= MAP_ROUTE_EVERY_MS };
                if !due {
                    return None;
                }
                // Недоступные цели — в начало очереди: карте важнее показать обрыв.
                Some((if down { i64::MIN } else { st.map_route_at }, r.clone(), Self::target_ip(&t, &st)?))
            })
            .collect();
        due.sort_by_key(|d| d.0);
        due.truncate(MAP_ROUTE_BATCH);
        for chunk in due.chunks(3) {
            let rounds = futures::future::join_all(
                chunk.iter().map(|(_, _, ip)| checks::trace_round(&p, *ip, 30, 64, Duration::from_millis(1200))),
            )
            .await;
            let at = now_ms();
            for ((_, r, _), round) in chunk.iter().zip(rounds) {
                // Хвост из неответивших хопов после последнего ответившего — просто таймауты.
                let last = round.hops.iter().rposition(|h| h.addr.is_some()).map_or(0, |i| i + 1);
                let hops = &round.hops[..last];
                for h in hops {
                    if let Some(a) = h.addr {
                        self.lookup_name(a);
                    }
                }
                let mut st = r.state.lock();
                st.map_check_at = at;
                if st.alert.down && !st.map_route.is_empty() && round.reached_ttl.is_none() {
                    // Авария: маршрут оставляем прежним, запоминаем, докуда пакеты ещё доходят.
                    st.map_reach = Some(last);
                    continue;
                }
                st.map_route = hops.iter().map(|h| h.addr).collect();
                st.map_rtts = hops.iter().map(|h| h.rtt_ms).collect();
                st.map_reached = round.reached_ttl.is_some();
                st.map_route_at = at;
                st.map_reach = None;
            }
        }
    }

    /// Всё, что нужно карте сети: маршруты до целей и сведения о промежуточных узлах.
    pub fn topology(&self) -> Topology {
        let now = now_ms();
        let names = self.hostnames();
        let mut routes = Vec::new();
        // Статистика хопов: по целям-трассировкам — задержка и потери за 5 минут,
        // по фоновым маршрутам — задержка последней проверки.
        let mut acc: HashMap<IpAddr, (u32, u32, f64, u32)> = HashMap::new(); // отправлено, потеряно, сумма rtt, ответов
        let mut last_rtt: HashMap<IpAddr, f32> = HashMap::new();
        let mut pending = 0;
        for id in self.order.read().iter() {
            let Some(r) = self.runners.read().get(id).cloned() else { continue };
            let t = r.target.read().clone();
            if !t.enabled {
                continue;
            }
            let st = r.state.lock();
            if t.kind == CheckKind::Trace {
                if st.route.is_empty() {
                    pending += 1;
                    continue;
                }
                let cutoff = now - 5 * 60_000;
                for smp in st.recent.iter().rev().take_while(|x| x.ts >= cutoff) {
                    for h in &smp.hops {
                        let known = (h.ttl as usize).checked_sub(1).and_then(|i| st.route.get(i).copied().flatten());
                        let Some(addr) = h.addr.or(known) else { continue };
                        let e = acc.entry(addr).or_default();
                        e.0 += 1;
                        match h.rtt_ms {
                            Some(v) if h.addr.is_some() => {
                                e.2 += v as f64;
                                e.3 += 1;
                            }
                            _ => e.1 += 1,
                        }
                    }
                }
                let reached = st.recent.back().map_or(false, |x| x.rtt_ms.is_some());
                let mut hops: Vec<Option<String>> = st.route.iter().map(|a| a.map(|a| a.to_string())).collect();
                // Последний хоп маршрута трассировки — сама цель, на карте она отдельным узлом.
                if hops.last().map_or(false, |h| h.is_some()) && st.route.last().copied().flatten() == Self::target_ip(&t, &st) {
                    hops.pop();
                }
                // Докуда доходят пакеты прямо сейчас: последний ответивший хоп свежего раунда.
                let reach = st.recent.back().filter(|x| x.rtt_ms.is_none()).map(|x| {
                    x.hops.iter().rposition(|h| h.rtt_ms.is_some()).map_or(0, |i| i + 1).min(hops.len())
                });
                routes.push(MapRoute { target_id: t.id.clone(), hops, reached, at: st.recent.back().map_or(0, |x| x.ts), live: true, reach });
            } else {
                if st.map_route_at == 0 {
                    pending += 1;
                    continue;
                }
                let target_ip = Self::target_ip(&t, &st);
                let mut hops = st.map_route.clone();
                if st.map_reached && hops.last().copied().flatten() == target_ip {
                    hops.pop();
                }
                for (a, rtt) in st.map_route.iter().zip(&st.map_rtts) {
                    if let (Some(a), Some(v)) = (a, rtt) {
                        last_rtt.insert(*a, *v);
                    }
                }
                routes.push(MapRoute {
                    target_id: t.id.clone(),
                    hops: hops.iter().map(|a| a.map(|a| a.to_string())).collect(),
                    reached: st.map_reached,
                    at: st.map_route_at,
                    live: false,
                    reach: if st.alert.down { st.map_reach } else { None },
                });
            }
        }
        let mut seen: HashSet<String> = HashSet::new();
        let mut hops = Vec::new();
        for route in &routes {
            for ip in route.hops.iter().flatten() {
                if !seen.insert(ip.clone()) {
                    continue;
                }
                let Ok(addr) = ip.parse::<IpAddr>() else { continue };
                let (rtt, loss) = match acc.get(&addr) {
                    Some(&(sent, lost, sum, n)) if sent > 0 => {
                        (if n > 0 { Some((sum / n as f64) as f32) } else { None }, Some(lost as f32 * 100.0 / sent as f32))
                    }
                    _ => (last_rtt.get(&addr).copied(), None),
                };
                let private = match addr {
                    IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local(),
                    IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80,
                };
                hops.push(MapHop { ip: ip.clone(), name: names.get(&addr).cloned(), private, rtt, loss });
            }
        }
        Topology { local_ip: local_ip().map(|a| a.to_string()), routes, hops, pending }
    }

    /// Раскладка карты сети (позиции, типы, иконки, подписи) — хранится как есть, её формат знает интерфейс.
    pub fn map_layout(&self) -> Result<Option<String>> {
        self.storage.get_kv("map_layout")
    }

    pub fn save_map_layout(&self, json: &str) -> Result<()> {
        // Проверяем, что это JSON: битое значение сломало бы карту при следующем открытии.
        serde_json::from_str::<serde_json::Value>(json).map_err(|e| anyhow!("раскладка карты: {e}"))?;
        self.storage.set_kv("map_layout", json)
    }

    fn lookup_name(self: &Arc<Self>, ip: IpAddr) {
        if self.dns.lock().contains_key(&ip) || !self.dns_pending.lock().insert(ip) {
            return;
        }
        let m = Arc::downgrade(self);
        self.rt.spawn(async move {
            let name = checks::reverse_dns(ip).await;
            if let Some(m) = m.upgrade() {
                m.dns.lock().insert(ip, name);
                m.dns_pending.lock().remove(&ip);
            }
        });
    }

    /// Имя недоступного предка цели (родитель, его родитель…), если такой есть.
    fn failed_ancestor(&self, id: &str) -> Option<String> {
        let runners = self.runners.read();
        let mut cur = runners.get(id).and_then(|r| r.target.read().parent_id.clone());
        let mut depth = 0;
        while let Some(pid) = cur {
            depth += 1;
            if depth > 32 {
                break;
            }
            let r = runners.get(&pid)?;
            let t = r.target.read();
            {
                let st = r.state.lock();
                // Родитель уже «недоступен» или его последняя проверка тоже не прошла.
                // Только устойчивая недоступность: один потерянный пакет у родителя не должен
                // глушить реальную аварию дочерней цели.
                let failing = t.enabled && st.alert.down;
                if failing {
                    return Some(t.name.clone());
                }
            }
            cur = t.parent_id.clone();
        }
        None
    }

    fn emit(&self, mut a: Alert) {
        // Режим тишины: уведомления у цели выключены — только запись в журнал.
        if self.runners.read().get(&a.target_id).map_or(false, |r| !r.target.read().alerts_enabled) {
            a.silent = true;
            a.notify = false;
        }
        // Зависимости: проблемы из-за недоступного родителя не уведомляем.
        const PROBLEM: [&str; 7] = ["down", "outage", "loss", "latency", "jitter", "mos", "warning"];
        const RECOVERY: [&str; 5] = ["recovered", "loss_ok", "latency_ok", "jitter_ok", "mos_ok"];
        let runner = self.runners.read().get(&a.target_id).cloned();
        if let Some(r) = runner {
            if PROBLEM.contains(&a.kind.as_str()) {
                let parent = self.failed_ancestor(&a.target_id);
                if parent.is_none() && a.kind != "outage" {
                    if let Some(cause) = self.quick_cause(&a.target_id, true) {
                        a.message = format!("{}\nПричина: {cause}", a.message);
                    }
                }
                if let Some(parent) = parent {
                    a.silent = true;
                    a.notify = false;
                    a.message = format!("{} — из-за недоступности «{parent}»", a.message);
                    if a.kind == "down" {
                        r.state.lock().suppressed_by_parent = true;
                    }
                }
            } else if RECOVERY.contains(&a.kind.as_str()) {
                let mut st = r.state.lock();
                if st.suppressed_by_parent {
                    a.silent = true;
                    a.notify = false;
                    if a.kind == "recovered" {
                        st.suppressed_by_parent = false;
                    }
                }
            }
        }
        let ev = EventRecord {
            id: 0,
            ts: now_ms(),
            target_id: Some(a.target_id.clone()),
            target_name: Some(a.target_name.clone()),
            kind: a.kind.clone(),
            severity: a.severity.clone(),
            message: a.message.clone(),
        };
        let _ = self.storage.insert_event(&ev);
        if a.notify {
            let ch = self.settings.read().channels.clone();
            let msg = a.message.clone();
            let storage = self.storage.clone();
            self.rt.spawn(async move {
                for (chan, err) in alerts::dispatch(&ch, "NetPulse", &msg).await {
                    let _ = storage.insert_event(&EventRecord {
                        id: 0,
                        ts: now_ms(),
                        target_id: None,
                        target_name: None,
                        kind: "channel_error".into(),
                        severity: "warning".into(),
                        message: format!("Не удалось отправить в {chan}: {err}"),
                    });
                }
            });
        }
        let _ = self.alerts_tx.send(a);
    }

    // ------------------------------------------------------------ views

    pub fn summaries(&self) -> Vec<TargetSummary> {
        let runners = self.runners.read();
        let rules = self.settings.read().alert_rules.clone();
        let now = now_ms();
        let mut list: Vec<TargetSummary> = self
            .order
            .read()
            .iter()
            .filter_map(|id| runners.get(id))
            .map(|r| {
                let t = r.target.read().clone();
                let st = r.state.lock();
                summarize(&t, &st, &rules, now)
            })
            .collect();
        // Зависимости: недоступная цель с недоступным предком — «из-за родителя».
        let by_id: HashMap<String, (Health, Option<String>, String)> =
            list.iter().map(|s| (s.id.clone(), (s.health, s.parent_id.clone(), s.name.clone()))).collect();
        for s in &mut list {
            if s.health != Health::Down {
                continue;
            }
            let mut cur = s.parent_id.clone();
            let mut depth = 0;
            while let Some(pid) = cur {
                depth += 1;
                let Some((h, next, name)) = by_id.get(&pid) else { break };
                if matches!(h, Health::Down | Health::Dependent) {
                    s.health = Health::Dependent;
                    s.blocked_by = Some(name.clone());
                    // Показываем самого верхнего недоступного предка.
                }
                if depth > 32 {
                    break;
                }
                cur = next.clone();
            }
        }
        // Момент последней смены состояния — для «так уже 14 минут» на табло.
        for s in &mut list {
            let Some(r) = runners.get(&s.id) else { continue };
            let mut st = r.state.lock();
            if st.health_seen != Some(s.health) {
                st.health_seen = Some(s.health);
                // У недоступной цели отсчёт ведём от первой потери, а не от момента,
                // когда движок признал её недоступной.
                st.health_since = match s.health {
                    Health::Down | Health::Dependent => st.outage_start.unwrap_or(now),
                    _ => now,
                };
            }
            s.state_since = st.health_since;
        }
        drop(runners);
        // Причина проблемы — коротко, для списка и табло (кэшируется в состоянии цели).
        let wide = self.monitor_wide();
        let names = self.hostnames();
        for s in &mut list {
            if matches!(s.health, Health::Down | Health::Crit | Health::Bad | Health::Warn) {
                s.cause = self.cause_cached(&s.id, wide, &names);
            }
        }
        list
    }

    fn hostnames(&self) -> HashMap<IpAddr, String> {
        self.dns.lock().iter().filter_map(|(k, v)| v.clone().map(|v| (*k, v))).collect()
    }

    /// Сколько целей сейчас не отвечает, всего активных и сколько среди них разных первых
    /// внешних хопов (чтобы отличить проблему своего канала от аварии одного направления).
    fn monitor_wide(&self) -> (usize, usize, usize) {
        let list: Vec<Arc<Runner>> = self.runners.read().values().cloned().collect();
        let now = now_ms();
        let (mut total, mut failing) = (0, 0);
        let mut heads: HashSet<IpAddr> = HashSet::new();
        for r in list {
            let t = r.target.read().clone();
            // Коды ответа сайтов не говорят о сети, поэтому HTTP и DNS не учитываем.
            if !t.enabled || !matches!(t.kind, CheckKind::Ping | CheckKind::Trace | CheckKind::Tcp) {
                continue;
            }
            let st = r.state.lock();
            let Some(last) = st.recent.back() else { continue };
            if now - last.ts > (t.interval_ms as i64 * 3).max(30_000) {
                continue; // данные устарели — цель не в счёт
            }
            total += 1;
            if last.rtt_ms.is_none() {
                failing += 1;
                if let Some(ip) = st.route.iter().flatten().find(|a| !is_local_addr(a)) {
                    heads.insert(*ip);
                }
            }
        }
        (failing, total, heads.len())
    }

    /// Короткая причина с кэшем: пересчитывается не чаще раза в 5 секунд на цель.
    fn cause_cached(&self, id: &str, wide: (usize, usize, usize), names: &HashMap<IpAddr, String>) -> Option<String> {
        let now = now_ms();
        let r = self.runners.read().get(id).cloned()?;
        {
            let st = r.state.lock();
            if now - st.cause_at < 5_000 {
                return st.cause.clone();
            }
        }
        let cause = self.cause_with(id, Some(wide), names, false);
        let mut st = r.state.lock();
        st.cause_at = now;
        st.cause = cause.clone();
        cause
    }

    /// Короткая причина по свежим данным (последние 10 минут).
    fn quick_cause(&self, id: &str, full: bool) -> Option<String> {
        let names = self.hostnames();
        self.cause_with(id, Some(self.monitor_wide()), &names, full)
    }

    fn cause_with(&self, id: &str, wide: Option<(usize, usize, usize)>, names: &HashMap<IpAddr, String>, full: bool) -> Option<String> {
        let now = now_ms();
        let r = self.runners.read().get(id).cloned()?;
        let t = r.target.read().clone();
        let (samples, resolve_error, cert_days, route, ip_change) = {
            let st = r.state.lock();
            let cutoff = now - 10 * 60_000;
            let first = st.recent.iter().position(|s| s.ts >= cutoff)?;
            let samples: Vec<Sample> = st.recent.iter().skip(first).cloned().collect();
            let route: Vec<(u8, Option<IpAddr>)> = st.route.iter().enumerate().map(|(i, a)| (i as u8 + 1, *a)).collect();
            let ip_change = st.ip_changed_at.filter(|ts| now - ts < 30 * 60_000).map(|ts| (ts, st.ip_change_msg.clone().unwrap_or_default()));
            (samples, st.resolve_error.clone(), st.cert_days, route, ip_change)
        };
        // Слишком мало или слишком старые данные — причины не показываем.
        if samples.len() < 5 || samples.last().map_or(true, |s| now - s.ts > (t.interval_ms as i64 * 3).max(30_000)) {
            return None;
        }
        let others = if full { self.other_routes(id) } else { vec![] };
        let rules = self.settings.read().alert_rules.clone();
        let inp = analyze::Input {
            kind: t.kind,
            host: &t.host,
            th: &t.thresholds,
            timeout_ms: t.timeout_ms,
            interval_ms: t.interval_ms,
            down_after: rules.down_after_samples.max(1) as usize,
            samples: &samples,
            hostnames: names,
            known_route: &route,
            parent_failing: self.failed_ancestor(id),
            monitor_wide: wide,
            flaps_hour: 0,
            route_change: None,
            ip_change,
            peak_hours: vec![],
            others,
            same_host: self.same_host(id),
            cert_days,
            cert_warn_days: rules.cert_days as i64,
            resolve_error,
            now,
            clamped: false,
        };
        analyze::analyze(&inp).cause
    }

    /// Другие проверки того же адреса: ping рядом с трассировкой, TCP-порт рядом с ping.
    fn same_host(&self, id: &str) -> Vec<analyze::SameHost> {
        let now = now_ms();
        let host = match self.runners.read().get(id) {
            Some(r) => r.target.read().host.trim().to_lowercase(),
            None => return vec![],
        };
        let key = host.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or(&host).to_string();
        let list: Vec<Arc<Runner>> = self.runners.read().values().cloned().collect();
        let mut out = vec![];
        for r in list {
            let t = r.target.read().clone();
            if t.id == id || !t.enabled {
                continue;
            }
            let h = t.host.trim().to_lowercase();
            let hk = h.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or(&h).to_string();
            if hk != key {
                continue;
            }
            let st = r.state.lock();
            let Some(last) = st.recent.back() else { continue };
            if now - last.ts > (t.interval_ms as i64 * 3).max(60_000) {
                continue;
            }
            let down_n = self.settings.read().alert_rules.down_after_samples.max(1) as usize;
            let failing = st.alert.down || (st.recent.len() >= down_n && st.recent.iter().rev().take(down_n).all(|s| s.rtt_ms.is_none()));
            out.push(analyze::SameHost { name: t.name.clone(), kind: t.kind, ok: !failing });
        }
        out
    }

    fn other_routes(&self, id: &str) -> Vec<analyze::OtherRoute> {
        let list: Vec<Arc<Runner>> = self.runners.read().values().cloned().collect();
        let mut out = vec![];
        for r in list {
            let t = r.target.read().clone();
            if t.id == id || !t.enabled || t.kind != CheckKind::Trace {
                continue;
            }
            let st = r.state.lock();
            let route: Vec<IpAddr> = st.route.iter().flatten().cloned().collect();
            if route.is_empty() {
                continue;
            }
            // «Проблема» — устойчивая недоступность, а не пара потерянных пакетов.
            out.push(analyze::OtherRoute { name: t.name.clone(), failing: st.alert.down, route });
        }
        out
    }

    // ------------------------------------------------------------ дубли ping + трассировка

    /// Пары «ping + трассировка» до одного и того же адреса.
    pub fn find_duplicates(&self) -> Vec<DuplicatePair> {
        let targets = self.list_targets();
        let mut out = Vec::new();
        for p in targets.iter().filter(|t| t.kind == CheckKind::Ping) {
            let host = p.host.trim().to_lowercase();
            if let Some(tr) = targets.iter().find(|t| t.kind == CheckKind::Trace && t.host.trim().to_lowercase() == host) {
                if out.iter().any(|d: &DuplicatePair| d.trace_id == tr.id) {
                    continue;
                }
                out.push(DuplicatePair {
                    host: p.host.clone(),
                    ping_id: p.id.clone(),
                    ping_name: p.name.clone(),
                    trace_id: tr.id.clone(),
                    trace_name: tr.name.clone(),
                    group: tr.group.clone(),
                });
            }
        }
        out
    }

    /// Объединяет пары: остаётся трассировка, долгая история и события ping-цели переносятся в неё.
    pub fn merge_duplicates(&self, pairs: &[DuplicatePair]) -> Result<usize> {
        let mut n = 0;
        for d in pairs {
            let both = {
                let runners = self.runners.read();
                runners.contains_key(&d.ping_id) && runners.contains_key(&d.trace_id)
            };
            if !both {
                continue;
            }
            self.storage.merge_history(&d.ping_id, &d.trace_id)?;
            // Цели, зависевшие от ping, теперь зависят от трассировки.
            let order = self.order.read().clone();
            for (i, oid) in order.iter().enumerate() {
                if let Some(r) = self.runners.read().get(oid) {
                    let mut t = r.target.write();
                    if t.parent_id.as_deref() == Some(d.ping_id.as_str()) {
                        t.parent_id = Some(d.trace_id.clone());
                        self.storage.save_target(&t, i as i64)?;
                    }
                }
            }
            self.delete_target(&d.ping_id)?;
            n += 1;
        }
        Ok(n)
    }

    // ------------------------------------------------------------ отчёты

    /// Отчёт SLA по всем целям за период.
    pub fn report(&self, from: i64, to: i64) -> Result<Vec<ReportRow>> {
        self.storage.rollup_recent(now_ms(), 20)?;
        let mut out = Vec::new();
        for t in self.list_targets() {
            let mut r = self.storage.report_stats(&t.id, from, to)?;
            r.id = t.id.clone();
            r.name = t.name.clone();
            r.host = t.host.clone();
            r.group = t.group.clone();
            r.kind = Some(t.kind);
            out.push(r);
        }
        Ok(out)
    }

    pub fn report_csv(&self, from: i64, to: i64) -> Result<String> {
        let rows = self.report(from, to)?;
        let fmt_ts = |ms: i64| {
            use chrono::TimeZone;
            chrono::Local.timestamp_millis_opt(ms).single().map(|d| d.format("%d.%m.%Y %H:%M").to_string()).unwrap_or_default()
        };
        let num = |v: Option<f32>, p: usize| v.map(|x| format!("{x:.p$}").replace('.', ",")).unwrap_or_default();
        // BOM + «;» — Excel открывает кириллицу и колонки без настройки.
        let mut out = String::from("\u{feff}");
        out.push_str(&format!("Отчёт NetPulse;{} — {}\n", fmt_ts(from), fmt_ts(to)));
        out.push_str("Группа;Цель;Адрес;Тип;Аптайм, %;Проверок;Потеряно;Потери, %;Средняя задержка, мс;Макс. задержка, мс;Простои (раз);Простой всего, мин;Инциденты;Худший час;Потери в худший час, %;Задержка в худший час, мс\n");
        for r in rows {
            let kind = match r.kind {
                Some(CheckKind::Trace) => "Трассировка",
                Some(CheckKind::Ping) => "Ping",
                Some(CheckKind::Http) => "HTTP(S)",
                Some(CheckKind::Tcp) => "TCP",
                Some(CheckKind::Dns) => "DNS",
                None => "",
            };
            let cells = [
                r.group.clone(),
                r.name.clone(),
                r.host.clone(),
                kind.to_string(),
                num(r.uptime_pct, 3),
                r.checks.to_string(),
                r.lost.to_string(),
                num(Some(r.loss_pct), 2),
                num(r.avg_ms, 1),
                num(r.max_ms, 1),
                r.outages.to_string(),
                (r.downtime_ms / 60_000).to_string(),
                r.incidents.to_string(),
                r.worst_hour.map(|h| format!("{h:02}:00–{:02}:00", (h + 1) % 24)).unwrap_or_default(),
                num(r.worst_hour.map(|_| r.worst_hour_loss), 2),
                num(r.worst_hour_avg, 1),
            ];
            let line: Vec<String> = cells
                .iter()
                .map(|c| if c.contains([';', '"', '\n']) { format!("\"{}\"", c.replace('"', "\"\"")) } else { c.clone() })
                .collect();
            out.push_str(&line.join(";"));
            out.push('\n');
        }
        Ok(out)
    }

    pub fn heatmap(&self, id: &str, from: i64, to: i64) -> Result<Vec<HeatCell>> {
        self.runner(id)?;
        self.storage.rollup_recent(now_ms(), 20)?;
        self.storage.heatmap(id, from, to)
    }

    /// Задержка каждого хопа трассировки во времени.
    pub fn hop_timelines(&self, id: &str, from: i64, to: i64, points: usize) -> Result<Vec<HopSeries>> {
        let r = self.runner(id)?;
        let samples = self.samples_between(&r, id, from, to)?;
        let (hops, _) = stats::trace_stats(&samples);
        let points = points.clamp(10, 1000);
        let dns = self.dns.lock();
        Ok(hops
            .into_iter()
            .map(|h| {
                let hostname = h.addr.as_ref().and_then(|a| a.parse::<IpAddr>().ok()).and_then(|ip| dns.get(&ip).cloned().flatten());
                HopSeries { ttl: h.ttl, points: stats::bucketize(&samples, Some(h.ttl), from, to, points), addr: h.addr, hostname }
            })
            .collect())
    }

    fn runner(&self, id: &str) -> Result<Arc<Runner>> {
        self.runners.read().get(id).cloned().ok_or_else(|| anyhow!("цель не найдена"))
    }

    /// Проверки за период: из памяти, если они там есть, иначе из базы.
    fn samples_between(&self, r: &Runner, id: &str, from: i64, to: i64) -> Result<Vec<Sample>> {
        {
            let st = r.state.lock();
            if let Some(first) = st.recent.front() {
                if first.ts <= from {
                    return Ok(st.recent.iter().filter(|s| s.ts >= from && s.ts <= to).cloned().collect());
                }
            }
        }
        self.storage.samples_range(id, from, to)
    }

    /// Полный разбор проблемы за период (не больше последних 3 часов периода).
    pub fn diagnose(&self, id: &str, from: i64, to: i64) -> Result<Diagnosis> {
        let r = self.runner(id)?;
        let t = r.target.read().clone();
        let now = now_ms();
        let to = to.min(now);
        let want_from = from;
        let from = from.max(to - 3 * 3_600_000);
        let samples = self.samples_between(&r, id, from, to)?;
        let (resolve_error, cert_days, route_change, route, ip_change) = {
            let st = r.state.lock();
            let rc = st.route_changed_at.filter(|ts| *ts >= from && *ts <= to).map(|ts| (ts, st.route_change_msg.clone().unwrap_or_default()));
            let ipc = st.ip_changed_at.filter(|ts| *ts >= from && *ts <= to).map(|ts| (ts, st.ip_change_msg.clone().unwrap_or_default()));
            let route: Vec<(u8, Option<IpAddr>)> = st.route.iter().enumerate().map(|(i, a)| (i as u8 + 1, *a)).collect();
            // Ошибка резолва актуальна только если она свежая.
            let err = st.resolve_error.clone().filter(|_| now - to < 60_000);
            (err, st.cert_days, rc, route, ipc)
        };
        let rules = self.settings.read().alert_rules.clone();
        // Завершённые обрывы за последний час периода (событие «down» — начало того же обрыва).
        let flaps_hour = self
            .storage
            .events(300, Some(id))
            .map(|ev| ev.iter().filter(|e| e.kind == "outage" && e.ts >= to - 3_600_000 && e.ts <= to).count())
            .unwrap_or(0);
        let peak_hours = if matches!(t.kind, CheckKind::Trace | CheckKind::Ping) {
            self.storage.problem_hours(id, now - 14 * 86_400_000, now, t.thresholds.warn_loss.max(2.0), t.thresholds.bad_ms).unwrap_or_default()
        } else {
            vec![]
        };
        let names = self.hostnames();
        let fresh = to >= now - 60_000;
        let inp = analyze::Input {
            kind: t.kind,
            host: &t.host,
            th: &t.thresholds,
            timeout_ms: t.timeout_ms,
            interval_ms: t.interval_ms,
            down_after: rules.down_after_samples.max(1) as usize,
            samples: &samples,
            hostnames: &names,
            known_route: &route,
            parent_failing: if fresh { self.failed_ancestor(id) } else { None },
            monitor_wide: fresh.then(|| self.monitor_wide()),
            flaps_hour,
            route_change,
            ip_change,
            peak_hours,
            others: if fresh { self.other_routes(id) } else { vec![] },
            same_host: if fresh { self.same_host(id) } else { vec![] },
            cert_days,
            cert_warn_days: rules.cert_days as i64,
            resolve_error,
            now,
            clamped: want_from < from - 1000,
        };
        let mut d = analyze::analyze(&inp);
        d.from = from;
        d.to = to;
        Ok(d)
    }

    pub fn trace_view(&self, id: &str, from: i64, to: i64) -> Result<TraceView> {
        let r = self.runner(id)?;
        let samples = self.samples_between(&r, id, from, to)?;
        let (mut hops, fin) = stats::trace_stats(&samples);
        // Бейдж «потери начинаются здесь» ставим по той же логике, что и анализатор.
        let interval = r.target.read().interval_ms as i64;
        let origin = analyze::loss_origin(&samples, (interval * 3).max(600));
        for h in &mut hops {
            h.suspect = Some(h.ttl) == origin;
        }
        {
            let dns = self.dns.lock();
            for h in &mut hops {
                if let Some(ip) = h.addr.as_ref().and_then(|a| a.parse::<IpAddr>().ok()) {
                    h.hostname = dns.get(&ip).cloned().flatten();
                }
            }
        }
        let mos = fin.avg.map(|a| stats::mos(a, fin.jitter.unwrap_or(0.0), fin.loss_pct));
        Ok(TraceView { from, to, samples: samples.len(), hops, final_stats: (fin.sent > 0).then_some(fin), mos })
    }

    pub fn timeline(&self, id: &str, ttl: Option<u8>, from: i64, to: i64, points: usize) -> Result<Vec<TimelinePoint>> {
        let r = self.runner(id)?;
        let points = points.clamp(10, 4000);
        let oldest_raw = self.storage.oldest_raw_ts(id)?.unwrap_or(i64::MAX);
        if from + 60_000 >= oldest_raw || ttl.is_some() {
            let samples = self.samples_between(&r, id, from, to)?;
            return Ok(stats::bucketize(&samples, ttl, from, to, points));
        }
        // Старый диапазон: минутные агрегаты + свежие raw-данные.
        let mut out = self.storage.rollup_timeline(id, from, oldest_raw.min(to), points)?;
        if oldest_raw < to {
            let samples = self.storage.samples_range(id, oldest_raw, to)?;
            let n = ((points as f64) * (to - oldest_raw) as f64 / (to - from).max(1) as f64).max(1.0) as usize;
            out.extend(stats::bucketize(&samples, None, oldest_raw, to, n));
        }
        Ok(out)
    }

    /// Таймлайны сразу для многих целей (вид «Графики»). Цели с ошибкой пропускаются.
    pub fn timelines(&self, ids: &[String], from: i64, to: i64, points: usize) -> HashMap<String, Vec<TimelinePoint>> {
        ids.iter()
            .filter_map(|id| self.timeline(id, None, from, to, points).ok().map(|t| (id.clone(), t)))
            .collect()
    }

    pub fn uptime(&self, id: &str, hours: u32) -> Result<Option<f32>> {
        self.storage.uptime(id, now_ms() - hours as i64 * 3_600_000)
    }

    pub fn events(&self, limit: usize, target_id: Option<&str>) -> Result<Vec<EventRecord>> {
        self.storage.events(limit, target_id)
    }

    pub fn clear_events(&self) -> Result<()> {
        self.storage.clear_events()
    }

    /// Стирает всю историю измерений: в базе и в памяти. Мониторинг продолжается.
    pub fn clear_history(&self, with_events: bool) -> Result<()> {
        for r in self.runners.read().values() {
            let mut st = r.state.lock();
            st.recent.clear();
            st.alert = AlertState::default();
        }
        self.storage.clear_history(with_events)
    }

    pub fn history_stats(&self) -> Result<HistoryStats> {
        let (samples, rollups, events, db_bytes) = self.storage.history_stats()?;
        Ok(HistoryStats { samples, rollups, events, db_bytes })
    }

    pub fn export_csv(&self, id: &str, from: i64, to: i64) -> Result<String> {
        let r = self.runner(id)?;
        let t = r.target.read().clone();
        let samples = self.storage.samples_range(id, from, to)?;
        let mut out = String::from("timestamp,iso_time,target,host,rtt_ms,lost,status_code,error,hops\n");
        for s in samples {
            let iso = chrono::DateTime::from_timestamp_millis(s.ts).map(|d| d.to_rfc3339()).unwrap_or_default();
            let hops: Vec<String> = s
                .hops
                .iter()
                .map(|h| {
                    format!(
                        "{}:{}:{}",
                        h.ttl,
                        h.addr.map(|a| a.to_string()).unwrap_or_else(|| "*".into()),
                        h.rtt_ms.map(|v| format!("{v:.1}")).unwrap_or_else(|| "*".into())
                    )
                })
                .collect();
            out.push_str(&format!(
                "{},{},{},{},{},{},{},{},{}\n",
                s.ts,
                iso,
                csv(&t.name),
                csv(&t.host),
                s.rtt_ms.map(|v| format!("{v:.2}")).unwrap_or_default(),
                s.rtt_ms.is_none() as u8,
                s.status_code.map(|c| c.to_string()).unwrap_or_default(),
                csv(s.error.as_deref().unwrap_or("")),
                csv(&hops.join(" "))
            ));
        }
        Ok(out)
    }

    pub fn export_config(&self, include_settings: bool) -> ConfigBundle {
        let mut settings = self.settings();
        // Секреты не выгружаем — коллеги настроят каналы сами.
        settings.channels.telegram.bot_token.clear();
        settings.channels.email.password.clear();
        settings.channels.webhook.url.clear();
        ConfigBundle {
            app: "NetPulse".into(),
            version: 1,
            targets: self.list_targets(),
            groups: self.groups(),
            settings: include_settings.then_some(settings),
        }
    }

    pub fn import_config(self: &Arc<Self>, bundle: ConfigBundle, replace: bool) -> Result<usize> {
        // Настройки (с шаблонами) — первыми, чтобы привязки целей к шаблонам не потерялись.
        if let Some(mut s) = bundle.settings.clone() {
            let cur = self.settings();
            if s.channels.telegram.bot_token.is_empty() {
                s.channels.telegram.bot_token = cur.channels.telegram.bot_token;
            }
            if s.channels.email.password.is_empty() {
                s.channels.email.password = cur.channels.email.password;
            }
            self.save_settings(s)?;
        }
        if replace {
            for t in self.list_targets() {
                self.delete_target(&t.id)?;
            }
        }
        for g in &bundle.groups {
            if let Ok(n) = Self::clean_group_name(g) {
                self.ensure_group(&n)?;
            }
        }
        // Без замены: цели с тем же адресом и типом обновляются (id и история сохраняются).
        let existing: HashMap<(String, CheckKind), String> =
            self.list_targets().into_iter().map(|t| ((t.host, t.kind), t.id)).collect();
        let mut n = 0;
        for mut t in bundle.targets {
            if !replace {
                if let Some(id) = existing.get(&(t.host.clone(), t.kind)) {
                    t.id = id.clone();
                    self.upsert_target(t)?;
                    n += 1;
                    continue;
                }
            }
            if self.runners.read().contains_key(&t.id) {
                t.id.clear();
            }
            self.upsert_target(t)?;
            n += 1;
        }
        Ok(n)
    }
}

fn csv(s: &str) -> String {
    if s.contains([',', '"', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Адрес из своей сети (частный, loopback, операторский NAT).
/// Адрес этого компьютера в сторону сети. Пакеты не отправляются: UDP-сокет только
/// выбирает исходящий интерфейс по таблице маршрутизации.
fn local_ip() -> Option<IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip()).filter(|a| !a.is_unspecified())
}

fn is_local_addr(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            v.is_private() || v.is_loopback() || v.is_link_local() || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(v) => v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// Человекочитаемое описание: на каком хопе какой IP сменился.
pub fn describe_route_change(old: &[Option<IpAddr>], new: &[Option<IpAddr>]) -> String {
    let mut parts = Vec::new();
    for i in 0..old.len().min(new.len()) {
        if let (Some(a), Some(b)) = (old[i], new[i]) {
            if a != b {
                parts.push(format!("хоп {}: {} → {}", i + 1, a, b));
            }
        }
    }
    let total = parts.len();
    parts.truncate(4);
    if total > 4 {
        parts.push(format!("и ещё {} хоп.", total - 4));
    }
    if old.len() != new.len() {
        parts.push(format!("хопов {} → {}", old.len(), new.len()));
    }
    if parts.is_empty() {
        "изменился путь".into()
    } else {
        parts.join("; ")
    }
}

fn fmt_clock(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms).single().map(|d| d.format("%H:%M:%S").to_string()).unwrap_or_default()
}

fn fmt_duration(ms: i64) -> String {
    let s = (ms as f64 / 1000.0).round() as i64;
    match s {
        0..=59 => format!("{s} с"),
        60..=3599 => format!("{} мин {} с", s / 60, s % 60),
        _ => format!("{} ч {} мин", s / 3600, (s % 3600) / 60),
    }
}

fn routes_differ(a: &[Option<IpAddr>], b: &[Option<IpAddr>]) -> bool {
    if a.len() != b.len() {
        return true;
    }
    a.iter().zip(b).any(|(x, y)| matches!((x, y), (Some(x), Some(y)) if x != y))
}

fn summarize(t: &Target, st: &RunState, rules: &AlertRules, now: i64) -> TargetSummary {
    // Окно статистики: последние 10 минут, но не меньше 10 сэмплов.
    let cutoff = now - 10 * 60_000;
    let mut n = st.recent.iter().rev().take_while(|s| s.ts >= cutoff).count();
    n = n.max(10).min(st.recent.len());
    let mut acc = stats::Acc::default();
    for s in st.recent.iter().skip(st.recent.len() - n) {
        acc.push(s.rtt_ms);
    }
    let last = st.recent.back();
    let spark: Vec<Option<f32>> = st.recent.iter().rev().take(60).rev().map(|s| s.rtt_ms).collect();
    let down_n = rules.down_after_samples.max(1) as usize;
    let is_down = st.alert.down
        || (st.recent.len() >= down_n && st.recent.iter().rev().take(down_n).all(|s| s.rtt_ms.is_none()));
    let avg = acc.avg();
    let loss = acc.loss_pct();
    let th = &t.thresholds;
    let health = if !t.enabled {
        Health::Paused
    } else if st.recent.is_empty() {
        Health::Unknown
    } else if is_down {
        Health::Down
    } else if t.kind == CheckKind::Http {
        // Сайт оценивается по коду ответа: 1xx/2xx/3xx — норма, 4xx/5xx — красный.
        // Время ответа на цвет статуса не влияет.
        if last.map_or(false, |s| s.error.is_some() && s.status_code.map_or(false, |c| c >= 400)) {
            Health::Crit
        } else {
            match th.loss_level(loss as f64) {
                3 => Health::Crit,
                2 => Health::Bad,
                1 => Health::Warn,
                _ => Health::Ok,
            }
        }
    } else {
        let jitter = acc.jitter().unwrap_or(0.0) as f64;
        let mos = avg.map(|a| stats::mos(a, jitter as f32, loss) as f64);
        let level = th
            .loss_level(loss as f64)
            .max(avg.map_or(0, |a| th.latency_level(a as f64)))
            .max(if avg.is_some() { th.jitter_level(jitter) } else { 0 })
            .max(mos.map_or(0, |m| th.mos_level(m)));
        match level {
            3 => Health::Crit,
            2 => Health::Bad,
            1 => Health::Warn,
            _ => Health::Ok,
        }
    };
    TargetSummary {
        id: t.id.clone(),
        name: t.name.clone(),
        host: t.host.clone(),
        group: t.group.clone(),
        kind: t.kind,
        enabled: t.enabled,
        alerts_enabled: t.alerts_enabled,
        health,
        resolved_ip: if t.kind == CheckKind::Dns { st.dns_answer.clone() } else { st.resolved.map(|i| i.to_string()) },
        last_rtt: last.and_then(|s| s.rtt_ms),
        avg_rtt: avg,
        min_rtt: acc.min,
        max_rtt: acc.max,
        jitter: acc.jitter(),
        loss_pct: loss,
        mos: avg.map(|a| stats::mos(a, acc.jitter().unwrap_or(0.0), loss)),
        hop_count: last.map_or(0, |s| s.hops.len()),
        status_code: last.and_then(|s| s.status_code),
        last_error: last.and_then(|s| s.error.clone()).or_else(|| st.resolve_error.clone()),
        cert_days: st.cert_days,
        route_changed_at: st.route_changed_at.filter(|ts| t.kind == CheckKind::Trace && now - ts < ROUTE_BADGE_MS),
        route_change: st.route_changed_at.filter(|ts| t.kind == CheckKind::Trace && now - ts < ROUTE_BADGE_MS).and(st.route_change_msg.clone()),
        spark,
        samples: st.recent.len(),
        last_ts: last.map(|s| s.ts),
        thresholds: t.thresholds.clone(),
        parent_id: t.parent_id.clone(),
        blocked_by: None,
        cause: None,
        state_since: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Регрессия: добавление цели из потока без tokio runtime (главный поток UI) не должно паниковать.
    #[test]
    fn upsert_from_non_runtime_thread() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let m = rt.block_on(async { Monitor::start_with_storage(Arc::new(Storage::in_memory().unwrap()), "mem".into()) }).unwrap();
        let m2 = m.clone();
        std::thread::spawn(move || {
            for i in 0..3 {
                let t = Target { name: format!("t{i}"), host: "127.0.0.1".into(), kind: CheckKind::Ping, ..Default::default() };
                let saved = m2.upsert_target(t).unwrap();
                m2.set_enabled(&saved.id, false).unwrap();
                m2.set_enabled(&saved.id, true).unwrap();
            }
        })
        .join()
        .expect("upsert_target паникует вне runtime");
        assert_eq!(m.list_targets().len(), 3);
    }

    #[test]
    fn topology_from_routes() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let m = rt.block_on(async { Monitor::start_with_storage(Arc::new(Storage::in_memory().unwrap()), "mem".into()) }).unwrap();
        let mk = |h: &str| Target { host: h.into(), kind: CheckKind::Ping, enabled: true, ..Default::default() };
        let a = m.upsert_target(mk("10.0.9.2")).unwrap();
        let b = m.upsert_target(mk("10.0.9.3")).unwrap();
        let c = m.upsert_target(mk("10.0.9.4")).unwrap();
        let ip = |s: &str| Some(s.parse::<IpAddr>().unwrap());
        {
            let rs = m.runners.read();
            // a и b идут через общий шлюз, a — дошла до цели; b — авария, отвечает только шлюз.
            for (id, route, reached) in [(&a.id, vec![ip("192.168.1.1"), None, ip("10.0.9.1"), ip("10.0.9.2")], true), (&b.id, vec![ip("192.168.1.1"), ip("10.0.9.1")], false)] {
                let mut st = rs[id].state.lock();
                st.map_route = route;
                st.map_rtts = vec![Some(1.0); 4];
                st.map_reached = reached;
                st.map_route_at = now_ms();
            }
            let mut st = rs[&b.id].state.lock();
            st.alert.down = true;
            st.map_reach = Some(1);
        }
        let t = m.topology();
        assert_eq!(t.pending, 1, "у третьей цели маршрута ещё нет");
        let ra = t.routes.iter().find(|r| r.target_id == a.id).unwrap();
        // Сама цель из маршрута убрана, неответивший хоп сохранён как пропуск.
        assert_eq!(ra.hops, vec![Some("192.168.1.1".into()), None, Some("10.0.9.1".into())]);
        assert!(ra.reached && ra.reach.is_none());
        let rb = t.routes.iter().find(|r| r.target_id == b.id).unwrap();
        assert_eq!(rb.reach, Some(1), "во время аварии известно, докуда доходят пакеты");
        // Общие хопы описаны один раз.
        assert_eq!(t.hops.len(), 2);
        assert!(t.hops.iter().all(|h| h.private));
        assert!(!t.routes.iter().any(|r| r.target_id == c.id));
        // Раскладка карты сохраняется как есть, мусор не принимается.
        m.save_map_layout(r#"{"v":1,"nodes":{}}"#).unwrap();
        assert_eq!(m.map_layout().unwrap().as_deref(), Some(r#"{"v":1,"nodes":{}}"#));
        assert!(m.save_map_layout("не json").is_err());
    }

    #[test]
    fn groups_crud() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let m = rt.block_on(async { Monitor::start_with_storage(Arc::new(Storage::in_memory().unwrap()), "mem".into()) }).unwrap();
        assert_eq!(m.groups(), vec!["Общее"]);
        m.add_group("Офис").unwrap();
        assert!(m.add_group("офис").is_err());
        let mk = |g: &str| Target { host: "127.0.0.1".into(), kind: CheckKind::Ping, group: g.into(), enabled: false, ..Default::default() };
        let a = m.upsert_target(mk("Офис")).unwrap();
        m.upsert_target(mk("ДЦ")).unwrap();
        assert_eq!(m.groups(), vec!["Общее", "Офис", "ДЦ"]);
        m.rename_group("Офис", "Главный офис").unwrap();
        assert_eq!(m.groups(), vec!["Общее", "Главный офис", "ДЦ"]);
        assert_eq!(m.list_targets().iter().find(|t| t.id == a.id).unwrap().group, "Главный офис");
        // слияние
        m.rename_group("ДЦ", "Главный офис").unwrap();
        assert_eq!(m.groups(), vec!["Общее", "Главный офис"]);
        assert_eq!(m.list_targets().iter().filter(|t| t.group == "Главный офис").count(), 2);
        m.delete_group("Главный офис", Some("Общее")).unwrap();
        assert_eq!(m.groups(), vec!["Общее"]);
        assert_eq!(m.list_targets().iter().filter(|t| t.group == "Общее").count(), 2);
        m.add_group("A").unwrap();
        m.add_group("B").unwrap();
        m.reorder_groups(vec!["B".into(), "Общее".into(), "A".into()]).unwrap();
        assert_eq!(m.groups(), vec!["Общее", "B", "A"]);
        m.delete_group("A", None).unwrap();
        m.delete_group("B", None).unwrap();
        assert!(m.delete_group("Общее", None).is_err());
        assert!(m.rename_group("Общее", "Другое").is_err());
        m.add_group("Тест").unwrap();
        m.move_targets(&[a.id.clone()], "Тест").unwrap();
        m.delete_group("Тест", None).unwrap();
        assert_eq!(m.list_targets().len(), 1);
    }

    #[test]
    fn clear_history_wipes_samples() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let st = Arc::new(Storage::in_memory().unwrap());
        for i in 0..50 {
            st.insert_sample("x", &Sample { ts: i, rtt_ms: Some(1.0), status_code: None, error: None, hops: vec![] }).unwrap();
        }
        let m = rt.block_on(async { Monitor::start_with_storage(st, "mem".into()) }).unwrap();
        assert_eq!(m.history_stats().unwrap().samples, 50);
        m.clear_history(true).unwrap();
        let h = m.history_stats().unwrap();
        assert_eq!((h.samples, h.rollups, h.events), (0, 0, 0));
    }

    #[test]
    fn route_change_text() {
        let ip = |s: &str| Some(s.parse::<IpAddr>().unwrap());
        let old = vec![ip("10.0.0.1"), ip("1.1.1.1"), None, ip("8.8.8.8")];
        let new = vec![ip("10.0.0.1"), ip("2.2.2.2"), ip("3.3.3.3"), ip("9.9.9.9"), ip("8.8.8.8")];
        assert_eq!(describe_route_change(&old, &new), "хоп 2: 1.1.1.1 → 2.2.2.2; хоп 4: 8.8.8.8 → 9.9.9.9; хопов 4 → 5");
    }

    #[test]
    fn route_change_detected_after_confirmation() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let m = rt.block_on(async { Monitor::start_with_storage(Arc::new(Storage::in_memory().unwrap()), "mem".into()) }).unwrap();
        let t = m.upsert_target(Target { name: "Офис".into(), host: "8.8.8.8".into(), kind: CheckKind::Trace, enabled: false, ..Default::default() }).unwrap();
        let r = m.runners.read().get(&t.id).cloned().unwrap();
        let round = |mid: &str| checks::TraceRound {
            hops: ["10.0.0.1", mid, "8.8.8.8"].iter().enumerate().map(|(i, a)| HopSample { ttl: i as u8 + 1, addr: Some(a.parse().unwrap()), rtt_ms: Some(1.0) }).collect(),
            dest_rtt: Some(1.0),
            reached_ttl: Some(3),
            needs_more: false,
        };
        let _g = rt.enter();
        m.track_route(&r, &t, &round("1.1.1.1"));
        m.track_route(&r, &t, &round("2.2.2.2"));
        m.track_route(&r, &t, &round("2.2.2.2"));
        assert!(m.summaries()[0].route_changed_at.is_none());
        m.track_route(&r, &t, &round("2.2.2.2"));
        let s = &m.summaries()[0];
        assert!(s.route_changed_at.is_some());
        assert_eq!(s.route_change.as_deref(), Some("хоп 2: 1.1.1.1 → 2.2.2.2"));
        let ev = m.events(10, Some(&t.id)).unwrap();
        assert_eq!(ev[0].severity, "route");
        assert!(ev[0].message.contains("хоп 2: 1.1.1.1 → 2.2.2.2"));

        // Прогрев после запуска: изменения маршрута не фиксируются, базовый маршрут обновляется.
        r.state.lock().started_at = now_ms();
        for _ in 0..5 {
            m.track_route(&r, &t, &round("3.3.3.3"));
        }
        assert_eq!(m.events(10, Some(&t.id)).unwrap().len(), 1);
        r.state.lock().started_at = 0;
        for _ in 0..5 {
            m.track_route(&r, &t, &round("3.3.3.3"));
        }
        assert_eq!(m.events(10, Some(&t.id)).unwrap().len(), 1);
        // Неполный раунд (почти все хопы молчат) игнорируется.
        let partial = checks::TraceRound {
            hops: (1..=29).map(|i| HopSample { ttl: i, addr: (i == 29).then(|| "8.8.8.8".parse().unwrap()), rtt_ms: None }).collect(),
            dest_rtt: Some(1.0),
            reached_ttl: Some(29),
            needs_more: false,
        };
        for _ in 0..5 {
            m.track_route(&r, &t, &partial);
        }
        assert_eq!(m.events(10, Some(&t.id)).unwrap().len(), 1);
    }

    #[test]
    fn http_health_by_status_code() {
        let t = Target { host: "https://site.ru".into(), kind: CheckKind::Http, enabled: true, ..Default::default() };
        let rules = AlertRules::default();
        let mut st = RunState::default();
        let ok = |ts: i64, rtt: f32| Sample { ts, rtt_ms: Some(rtt), status_code: Some(200), error: None, hops: vec![] };
        for i in 0..10 {
            st.recent.push_back(ok(now_ms() - 10_000 + i * 1000, 1800.0)); // медленно, но 200 — зелёный
        }
        assert_eq!(summarize(&t, &st, &rules, now_ms()).health, Health::Ok);
        st.recent.push_back(Sample { ts: now_ms(), rtt_ms: None, status_code: Some(404), error: Some("неожиданный код ответа 404".into()), hops: vec![] });
        assert_eq!(summarize(&t, &st, &rules, now_ms()).health, Health::Crit);
    }

    #[test]
    fn muted_target_events_are_silent() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let m = rt.block_on(async { Monitor::start_with_storage(Arc::new(Storage::in_memory().unwrap()), "mem".into()) }).unwrap();
        let t = m.upsert_target(Target { host: "1.1.1.1".into(), kind: CheckKind::Ping, enabled: false, alerts_enabled: false, ..Default::default() }).unwrap();
        let mut rx = m.alerts_tx.subscribe();
        m.emit(Alert { target_id: t.id.clone(), target_name: "x".into(), kind: "down".into(), severity: "critical".into(), message: "down".into(), notify: true, silent: false });
        let a = rx.try_recv().unwrap();
        assert!(a.silent && !a.notify);
        assert_eq!(m.events(10, Some(&t.id)).unwrap().len(), 1); // история сохраняется
    }

    #[test]
    fn dependency_suppresses_child_alerts() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let m = rt.block_on(async { Monitor::start_with_storage(Arc::new(Storage::in_memory().unwrap()), "mem".into()) }).unwrap();
        let parent = m.upsert_target(Target { name: "Роутер".into(), host: "10.0.0.1".into(), kind: CheckKind::Ping, enabled: false, ..Default::default() }).unwrap();
        let child = m.upsert_target(Target { name: "Сервер".into(), host: "10.0.0.2".into(), kind: CheckKind::Ping, enabled: false, parent_id: Some(parent.id.clone()), ..Default::default() }).unwrap();
        // цикл запрещён
        let mut p2 = parent.clone();
        p2.parent_id = Some(child.id.clone());
        assert!(m.upsert_target(p2).is_err());
        // родитель «включён» и устойчиво недоступен (одной потерянной проверки мало)
        {
            let r = m.runners.read().get(&parent.id).cloned().unwrap();
            r.target.write().enabled = true;
            let mut st = r.state.lock();
            st.recent.push_back(Sample { ts: 1, rtt_ms: None, status_code: None, error: None, hops: vec![] });
            st.alert.down = true;
        }
        // одна потерянная проверка у родителя не должна глушить аварию ребёнка
        {
            let r = m.runners.read().get(&parent.id).cloned().unwrap();
            r.state.lock().alert.down = false;
        }
        {
            let mut rx0 = m.alerts_tx.subscribe();
            m.emit(Alert { target_id: child.id.clone(), target_name: "Сервер".into(), kind: "down".into(), severity: "critical".into(), message: "down".into(), notify: true, silent: false });
            let a0 = rx0.try_recv().unwrap();
            assert!(!a0.silent && a0.notify, "родитель ещё не признан недоступным");
        }
        {
            let r = m.runners.read().get(&parent.id).cloned().unwrap();
            r.state.lock().alert.down = true;
        }
        let mut rx = m.alerts_tx.subscribe();
        m.emit(Alert { target_id: child.id.clone(), target_name: "Сервер".into(), kind: "down".into(), severity: "critical".into(), message: "down".into(), notify: true, silent: false });
        let a = rx.try_recv().unwrap();
        assert!(a.silent && !a.notify && a.message.contains("Роутер"));
        m.emit(Alert { target_id: child.id.clone(), target_name: "Сервер".into(), kind: "recovered".into(), severity: "ok".into(), message: "up".into(), notify: true, silent: false });
        assert!(rx.try_recv().unwrap().silent);
    }

    #[test]
    fn merge_duplicates_moves_history() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let st = Arc::new(Storage::in_memory().unwrap());
        let m = rt.block_on(async { Monitor::start_with_storage(st.clone(), "mem".into()) }).unwrap();
        let p = m.upsert_target(Target { name: "A".into(), host: "1.2.3.4".into(), kind: CheckKind::Ping, enabled: false, ..Default::default() }).unwrap();
        let t = m.upsert_target(Target { name: "A".into(), host: "1.2.3.4".into(), kind: CheckKind::Trace, enabled: false, ..Default::default() }).unwrap();
        for i in 0..60 {
            st.insert_sample(&p.id, &Sample { ts: 60_000 * 10 + i * 1000, rtt_ms: Some(2.0), status_code: None, error: None, hops: vec![] }).unwrap();
            st.insert_sample(&t.id, &Sample { ts: 60_000 * 10 + i * 1000, rtt_ms: if i < 30 { None } else { Some(4.0) }, status_code: None, error: None, hops: vec![] }).unwrap();
        }
        let d = m.find_duplicates();
        assert_eq!(d.len(), 1);
        assert_eq!(m.merge_duplicates(&d).unwrap(), 1);
        assert_eq!(m.list_targets().len(), 1);
        let r = st.report_stats(&t.id, 0, 60_000 * 20).unwrap();
        assert_eq!(r.checks, 120);
        assert_eq!(r.lost, 30);
        assert!((r.avg_ms.unwrap() - (60.0 * 2.0 + 30.0 * 4.0) / 90.0).abs() < 0.01);
    }

    #[test]
    fn dns_packet_roundtrip() {
        let q = checks::build_dns_query(0x1234, "example.com").unwrap();
        assert_eq!(&q[12..], &[7, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 3, b'c', b'o', b'm', 0, 0, 1, 0, 1]);
        // ответ: заголовок + вопрос + A-запись со ссылкой на имя
        let mut resp = vec![0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0];
        resp.extend_from_slice(&q[12..]);
        resp.extend_from_slice(&[0xC0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 10]);
        assert_eq!(checks::parse_dns_response(&resp).unwrap(), vec!["203.0.113.10".parse::<IpAddr>().unwrap()]);
        resp[3] = 0x83;
        assert!(checks::parse_dns_response(&resp).unwrap_err().contains("NXDOMAIN"));
    }

    #[test]
    fn templates_linking() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let m = rt.block_on(async { Monitor::start_with_storage(Arc::new(Storage::in_memory().unwrap()), "mem".into()) }).unwrap();
        let mk = |g: &str| Target { host: "127.0.0.1".into(), kind: CheckKind::Ping, group: g.into(), enabled: false, ..Default::default() };
        let a = m.upsert_target(mk("VPN")).unwrap();
        let b = m.upsert_target(mk("VPN")).unwrap();
        let c = m.upsert_target(mk("Офис")).unwrap();
        let mut s = m.settings();
        s.templates.push(TargetTemplate { id: "vpn".into(), name: "VPN".into(), interval_ms: 5000, timeout_ms: 2000, thresholds: Thresholds { warn_ms: 100.0, bad_ms: 200.0, crit_ms: 500.0, ..Default::default() }, alerts_enabled: true, groups: vec!["VPN".into()] });
        m.save_settings(s.clone()).unwrap();
        assert_eq!(m.set_template_targets("vpn", &[a.id.clone(), b.id.clone()]).unwrap(), 2);
        let get = |id: &str| m.list_targets().into_iter().find(|t| t.id == id).unwrap();
        assert_eq!(get(&a.id).interval_ms, 5000);
        assert_eq!(get(&a.id).thresholds.warn_ms, 100.0);
        // Изменение шаблона доходит до привязанных целей.
        s.templates.last_mut().unwrap().thresholds.warn_ms = 150.0;
        m.save_settings(s.clone()).unwrap();
        assert_eq!(get(&b.id).thresholds.warn_ms, 150.0);
        assert_eq!(get(&c.id).thresholds.warn_ms, Thresholds::default().warn_ms);
        // Перенос в группу с шаблоном — цель получает шаблон.
        m.move_targets(&[c.id.clone()], "VPN").unwrap();
        m.apply_group_templates(&[c.id.clone()]).unwrap();
        assert_eq!(get(&c.id).template_id.as_deref(), Some("vpn"));
        // Отвязка сохраняет значения.
        m.set_template_targets("vpn", &[a.id.clone()]).unwrap();
        assert_eq!(get(&b.id).template_id, None);
        assert_eq!(get(&b.id).thresholds.warn_ms, 150.0);
        // Переименование группы и удаление шаблона.
        m.rename_group("VPN", "Туннели").unwrap();
        assert_eq!(m.settings().templates.last().unwrap().groups, vec!["Туннели".to_string()]);
        s = m.settings();
        s.templates.retain(|t| t.id != "vpn");
        m.save_settings(s).unwrap();
        assert_eq!(get(&a.id).template_id, None);
        assert_eq!(get(&a.id).interval_ms, 5000);
    }

    #[test]
    fn settings_without_templates_get_defaults() {
        let s: Settings = serde_json::from_str(r#"{"defaultIntervalMs": 5000}"#).unwrap();
        assert_eq!(s.default_interval_ms, 5000);
        assert_eq!(s.templates.len(), 5);
        assert!(s.templates.iter().any(|t| t.name == "Телефония" && t.thresholds.mos_crit == 3.6));
    }

    #[test]
    fn outage_events_min_5s() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let m = rt.block_on(async { Monitor::start_with_storage(Arc::new(Storage::in_memory().unwrap()), "mem".into()) }).unwrap();
        let t = m.upsert_target(Target { host: "1.1.1.1".into(), kind: CheckKind::Ping, enabled: false, ..Default::default() }).unwrap();
        let r = m.runners.read().get(&t.id).cloned().unwrap();
        let smp = |ts: i64, ok: bool| Sample { ts, rtt_ms: ok.then_some(1.0), status_code: None, error: None, hops: vec![] };
        assert_eq!(m.track_outage(&r, &smp(0, true)), None);
        assert_eq!(m.track_outage(&r, &smp(1000, false)), None);
        assert_eq!(m.track_outage(&r, &smp(3500, true)), None); // 2.5 с — не фиксируем
        assert_eq!(m.track_outage(&r, &smp(4000, false)), None);
        assert_eq!(m.track_outage(&r, &smp(6500, false)), None);
        assert_eq!(m.track_outage(&r, &smp(9000, true)), Some((4000, 9000)));
        assert_eq!(fmt_duration(5000), "5 с");
        assert_eq!(fmt_duration(125_000), "2 мин 5 с");
    }
}
