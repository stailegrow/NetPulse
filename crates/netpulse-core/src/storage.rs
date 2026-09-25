use crate::model::{EventRecord, HeatCell, HopSample, ReportRow, Sample, Settings, Target, TimelinePoint};
use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

pub struct Storage {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, position INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS samples (
    target_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    rtt REAL,
    status INTEGER,
    err TEXT,
    hops BLOB
);
CREATE INDEX IF NOT EXISTS samples_target_ts ON samples(target_id, ts);
CREATE INDEX IF NOT EXISTS samples_ts ON samples(ts);
CREATE TABLE IF NOT EXISTS rollup (
    target_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cnt INTEGER NOT NULL,
    lost INTEGER NOT NULL,
    min REAL, avg REAL, max REAL,
    PRIMARY KEY (target_id, ts)
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    target_id TEXT,
    target_name TEXT,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_target_ts ON events(target_id, ts);
"#;

pub fn encode_hops(hops: &[HopSample]) -> Vec<u8> {
    let mut out = Vec::with_capacity(hops.len() * 10);
    for h in hops {
        out.push(h.ttl);
        match h.addr {
            None => out.push(0),
            Some(IpAddr::V4(a)) => {
                out.push(4);
                out.extend_from_slice(&a.octets());
            }
            Some(IpAddr::V6(a)) => {
                out.push(6);
                out.extend_from_slice(&a.octets());
            }
        }
        out.extend_from_slice(&h.rtt_ms.unwrap_or(f32::NAN).to_le_bytes());
    }
    out
}

pub fn decode_hops(mut b: &[u8]) -> Vec<HopSample> {
    let mut out = Vec::new();
    while b.len() >= 2 {
        let ttl = b[0];
        let (addr, rest) = match b[1] {
            4 if b.len() >= 6 => {
                (Some(IpAddr::V4(Ipv4Addr::new(b[2], b[3], b[4], b[5]))), &b[6..])
            }
            6 if b.len() >= 18 => {
                let mut o = [0u8; 16];
                o.copy_from_slice(&b[2..18]);
                (Some(IpAddr::V6(Ipv6Addr::from(o))), &b[18..])
            }
            0 => (None, &b[2..]),
            _ => break,
        };
        if rest.len() < 4 {
            break;
        }
        let v = f32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]);
        out.push(HopSample { ttl, addr, rtt_ms: (!v.is_nan()).then_some(v) });
        b = &rest[4..];
    }
    out
}

impl Storage {
    /// Открывает базу. Если файл повреждён, он переименовывается, а работа продолжается
    /// с чистой базой: мониторинг важнее истории. Второе значение — сообщение для пользователя.
    pub fn open(path: &Path) -> Result<(Self, Option<String>)> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        match Self::try_open(path) {
            Ok(s) => Ok((s, None)),
            Err(err) => {
                log::error!("база повреждена ({err}), начинаю с чистой");
                let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
                let backup = path.with_file_name(format!("netpulse-повреждена-{stamp}.db"));
                let _ = std::fs::rename(path, &backup);
                for suffix in ["-wal", "-shm"] {
                    let side = PathBuf::from(format!("{}{suffix}", path.display()));
                    let _ = std::fs::remove_file(side);
                }
                let s = Self::try_open(path)?;
                Ok((
                    s,
                    Some(format!(
                        "Файл базы данных был повреждён и переименован в «{}». Мониторинг работает, но история и настройки начаты заново.",
                        backup.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
                    )),
                ))
            }
        }
    }

    fn try_open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).unwrap_or_else(|_| "fail".into());
        if check != "ok" {
            return Err(anyhow::anyhow!("проверка целостности: {check}"));
        }
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ------------------------------------------------------------ targets / settings

    pub fn load_targets(&self) -> Result<Vec<Target>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT json FROM targets ORDER BY position, rowid")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for j in rows {
            if let Ok(t) = serde_json::from_str::<Target>(&j?) {
                out.push(t);
            }
        }
        Ok(out)
    }

    pub fn save_target(&self, t: &Target, position: i64) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO targets(id, position, json) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET json = excluded.json, position = excluded.position",
            params![t.id, position, serde_json::to_string(t)?],
        )?;
        Ok(())
    }

    pub fn delete_target(&self, id: &str) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM targets WHERE id = ?1", [id])?;
        tx.execute("DELETE FROM samples WHERE target_id = ?1", [id])?;
        tx.execute("DELETE FROM rollup WHERE target_id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn load_groups(&self) -> Result<Vec<String>> {
        let c = self.conn.lock();
        let v: Option<String> = c
            .query_row("SELECT value FROM kv WHERE key = 'groups'", [], |r| r.get(0))
            .optional()?;
        Ok(v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
    }

    pub fn save_groups(&self, groups: &[String]) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO kv(key, value) VALUES ('groups', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [serde_json::to_string(groups)?],
        )?;
        Ok(())
    }

    pub fn load_settings(&self) -> Result<Settings> {
        let c = self.conn.lock();
        let v: Option<String> = c
            .query_row("SELECT value FROM kv WHERE key = 'settings'", [], |r| r.get(0))
            .optional()?;
        Ok(v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
    }

    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO kv(key, value) VALUES ('settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [serde_json::to_string(s)?],
        )?;
        Ok(())
    }

    /// Произвольное значение в kv (например, раскладка карты сети). Хранится как есть.
    pub fn get_kv(&self, key: &str) -> Result<Option<String>> {
        let c = self.conn.lock();
        Ok(c.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_kv(&self, key: &str, value: &str) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO kv(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------ samples

    pub fn insert_sample(&self, target_id: &str, s: &Sample) -> Result<()> {
        self.insert_samples(&[(target_id.to_string(), s.clone())])
    }

    /// Пакетная запись: при сотне целей это одна транзакция вместо сотни.
    pub fn insert_samples(&self, batch: &[(String, Sample)]) -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        {
            let mut st = tx.prepare_cached("INSERT INTO samples(target_id, ts, rtt, status, err, hops) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
            for (id, s) in batch {
                let hops = (!s.hops.is_empty()).then(|| encode_hops(&s.hops));
                st.execute(params![id, s.ts, s.rtt_ms, s.status_code, s.error, hops])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn samples_range(&self, target_id: &str, from: i64, to: i64) -> Result<Vec<Sample>> {
        let c = self.conn.lock();
        let mut st = c.prepare_cached(
            "SELECT ts, rtt, status, err, hops FROM samples
             WHERE target_id = ?1 AND ts >= ?2 AND ts <= ?3 ORDER BY ts",
        )?;
        let rows = st.query_map(params![target_id, from, to], |r| {
            let hops: Option<Vec<u8>> = r.get(4)?;
            Ok(Sample {
                ts: r.get(0)?,
                rtt_ms: r.get::<_, Option<f64>>(1)?.map(|v| v as f32),
                status_code: r.get(2)?,
                error: r.get(3)?,
                hops: hops.map(|b| decode_hops(&b)).unwrap_or_default(),
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn oldest_raw_ts(&self, target_id: &str) -> Result<Option<i64>> {
        Ok(self.conn.lock().query_row(
            "SELECT MIN(ts) FROM samples WHERE target_id = ?1",
            [target_id],
            |r| r.get(0),
        )?)
    }

    /// Таймлайн из минутных агрегатов (для периодов старше raw-ретеншна).
    pub fn rollup_timeline(&self, target_id: &str, from: i64, to: i64, points: usize) -> Result<Vec<TimelinePoint>> {
        let step = (((to - from) / points.max(1) as i64).max(60_000) / 60_000) * 60_000;
        let c = self.conn.lock();
        let mut st = c.prepare_cached(
            "SELECT (ts - ?2) / ?4 AS b, SUM(cnt), SUM(lost), MIN(min), SUM(avg * (cnt - lost)) / NULLIF(SUM(cnt - lost), 0), MAX(max)
             FROM rollup WHERE target_id = ?1 AND ts >= ?2 AND ts <= ?3 GROUP BY b ORDER BY b",
        )?;
        let rows = st.query_map(params![target_id, from, to, step], |r| {
            let b: i64 = r.get(0)?;
            let cnt: i64 = r.get(1)?;
            let lost: i64 = r.get(2)?;
            Ok(TimelinePoint {
                ts: from + b * step,
                min: r.get::<_, Option<f64>>(3)?.map(|v| v as f32),
                avg: r.get::<_, Option<f64>>(4)?.map(|v| v as f32),
                max: r.get::<_, Option<f64>>(5)?.map(|v| v as f32),
                loss_pct: if cnt > 0 { lost as f32 * 100.0 / cnt as f32 } else { 0.0 },
                count: cnt as u32,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Аптайм (% успешных сэмплов) по минутным агрегатам за период.
    pub fn uptime(&self, target_id: &str, from: i64) -> Result<Option<f32>> {
        let c = self.conn.lock();
        let (cnt, lost): (Option<i64>, Option<i64>) = c.query_row(
            "SELECT SUM(cnt), SUM(lost) FROM rollup WHERE target_id = ?1 AND ts >= ?2",
            params![target_id, from],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(match (cnt, lost) {
            (Some(c), Some(l)) if c > 0 => Some(100.0 - l as f32 * 100.0 / c as f32),
            _ => None,
        })
    }

    /// Переносит долгую историю (минутные агрегаты и события) цели `from` в цель `to`.
    /// Пересекающиеся минуты объединяются с учётом числа проверок.
    pub fn merge_history(&self, from: &str, to: &str) -> Result<()> {
        let c = self.conn.lock();
        // Досчитываем агрегаты по свежим сырым данным обеих целей.
        c.execute(
            "INSERT OR REPLACE INTO rollup(target_id, ts, cnt, lost, min, avg, max)
             SELECT target_id, (ts / 60000) * 60000 AS m, COUNT(*), SUM(rtt IS NULL), MIN(rtt), AVG(rtt), MAX(rtt)
             FROM samples WHERE target_id IN (?1, ?2) GROUP BY target_id, m",
            params![from, to],
        )?;
        c.execute(
            "INSERT INTO rollup(target_id, ts, cnt, lost, min, avg, max)
             SELECT ?2, ts, cnt, lost, min, avg, max FROM rollup WHERE target_id = ?1
             ON CONFLICT(target_id, ts) DO UPDATE SET
               avg = COALESCE((COALESCE(avg, 0) * (cnt - lost) + COALESCE(excluded.avg, 0) * (excluded.cnt - excluded.lost))
                     / NULLIF((cnt - lost) + (excluded.cnt - excluded.lost), 0), avg, excluded.avg),
               min = CASE WHEN min IS NULL THEN excluded.min WHEN excluded.min IS NULL THEN min ELSE MIN(min, excluded.min) END,
               max = CASE WHEN max IS NULL THEN excluded.max WHEN excluded.max IS NULL THEN max ELSE MAX(max, excluded.max) END,
               cnt = cnt + excluded.cnt,
               lost = lost + excluded.lost",
            params![from, to],
        )?;
        c.execute("DELETE FROM rollup WHERE target_id = ?1", [from])?;
        c.execute("UPDATE events SET target_id = ?2 WHERE target_id = ?1", params![from, to])?;
        Ok(())
    }

    /// Минутные агрегаты цели за период: (ts, cnt, lost, avg, max).
    fn rollup_rows(&self, id: &str, from: i64, to: i64) -> Result<Vec<(i64, i64, i64, Option<f64>, Option<f64>)>> {
        let c = self.conn.lock();
        let mut st = c.prepare_cached(
            "SELECT ts, cnt, lost, avg, max FROM rollup WHERE target_id = ?1 AND ts >= ?2 AND ts < ?3 ORDER BY ts",
        )?;
        let rows = st.query_map(params![id, from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Показатели SLA по минутным агрегатам.
    pub fn report_stats(&self, id: &str, from: i64, to: i64) -> Result<ReportRow> {
        let rows = self.rollup_rows(id, from, to)?;
        let mut r = ReportRow::default();
        let (mut ok_n, mut sum) = (0i64, 0f64);
        let mut max: Option<f64> = None;
        let mut prev_down_ts: Option<i64> = None;
        let mut hours = [(0i64, 0i64, 0f64, 0i64); 24]; // cnt, lost, sum_avg, ok
        for (ts, cnt, lost, avg, mx) in &rows {
            r.checks += cnt;
            r.lost += lost;
            if let Some(a) = avg {
                sum += a * (cnt - lost) as f64;
                ok_n += cnt - lost;
            }
            if let Some(m) = mx {
                max = Some(max.map_or(*m, |x: f64| x.max(*m)));
            }
            if *cnt > 0 && lost == cnt {
                r.downtime_ms += 60_000;
                if prev_down_ts != Some(ts - 60_000) {
                    r.outages += 1;
                }
                prev_down_ts = Some(*ts);
            }
            use chrono::{TimeZone, Timelike};
            if let Some(d) = chrono::Local.timestamp_millis_opt(*ts).single() {
                let h = &mut hours[d.hour() as usize];
                h.0 += cnt;
                h.1 += lost;
                if let Some(a) = avg {
                    h.2 += a * (cnt - lost) as f64;
                    h.3 += cnt - lost;
                }
            }
        }
        if r.checks > 0 {
            r.loss_pct = r.lost as f32 * 100.0 / r.checks as f32;
            r.uptime_pct = Some(100.0 - r.loss_pct);
        }
        r.avg_ms = (ok_n > 0).then(|| (sum / ok_n as f64) as f32);
        r.max_ms = max.map(|v| v as f32);
        // Худший час: сначала по потерям, при равных — по задержке.
        let mut best: Option<(u8, f32, Option<f32>)> = None;
        for (i, h) in hours.iter().enumerate() {
            if h.0 == 0 {
                continue;
            }
            let loss = h.1 as f32 * 100.0 / h.0 as f32;
            let avg = (h.3 > 0).then(|| (h.2 / h.3 as f64) as f32);
            let worse = match best {
                None => true,
                Some((_, bl, ba)) => loss > bl + 0.01 || ((loss - bl).abs() <= 0.01 && avg.unwrap_or(0.0) > ba.unwrap_or(0.0)),
            };
            if worse {
                best = Some((i as u8, loss, avg));
            }
        }
        if let Some((h, l, a)) = best {
            r.worst_hour = Some(h);
            r.worst_hour_loss = l;
            r.worst_hour_avg = a;
        }
        r.incidents = self.conn.lock().query_row(
            "SELECT COUNT(*) FROM events WHERE target_id = ?1 AND ts >= ?2 AND ts < ?3 AND kind IN ('down', 'outage')",
            params![id, from, to],
            |row| row.get(0),
        )?;
        Ok(r)
    }

    /// Тепловая карта «день недели × час» (локальное время) по минутным агрегатам.
    pub fn heatmap(&self, id: &str, from: i64, to: i64) -> Result<Vec<HeatCell>> {
        let rows = self.rollup_rows(id, from, to)?;
        let mut grid = vec![(0i64, 0i64, 0f64, 0i64); 7 * 24];
        use chrono::{Datelike, TimeZone, Timelike};
        for (ts, cnt, lost, avg, _) in rows {
            if let Some(d) = chrono::Local.timestamp_millis_opt(ts).single() {
                let i = d.weekday().num_days_from_monday() as usize * 24 + d.hour() as usize;
                let g = &mut grid[i];
                g.0 += cnt;
                g.1 += lost;
                if let Some(a) = avg {
                    g.2 += a * (cnt - lost) as f64;
                    g.3 += cnt - lost;
                }
            }
        }
        Ok(grid
            .into_iter()
            .enumerate()
            .map(|(i, g)| HeatCell {
                dow: (i / 24) as u8,
                hour: (i % 24) as u8,
                avg: (g.3 > 0).then(|| (g.2 / g.3 as f64) as f32),
                loss_pct: if g.0 > 0 { g.1 as f32 * 100.0 / g.0 as f32 } else { 0.0 },
                count: g.0,
            })
            .collect())
    }

    /// Часы суток, в которые проблемы повторяются в разные календарные дни.
    /// Нужны минимум 3 разных дня, иначе это один длинный инцидент, а не закономерность.
    pub fn problem_hours(&self, id: &str, from: i64, to: i64, warn_loss: f64, bad_ms: f64) -> Result<Vec<u8>> {
        use chrono::{Datelike, TimeZone, Timelike};
        let rows = self.rollup_rows(id, from, to)?;
        // (день, час) → (проверок, потеряно, сумма задержки, ответов)
        let mut grid: HashMap<(i32, u32, u32), (i64, i64, f64, i64)> = HashMap::new();
        for (ts, cnt, lost, avg, _) in rows {
            let Some(d) = chrono::Local.timestamp_millis_opt(ts).single() else { continue };
            let e = grid.entry((d.year(), d.ordinal(), d.hour())).or_default();
            e.0 += cnt;
            e.1 += lost;
            if let Some(a) = avg {
                e.2 += a * (cnt - lost) as f64;
                e.3 += cnt - lost;
            }
        }
        let mut bad_days: HashMap<u32, HashSet<(i32, u32)>> = HashMap::new();
        let mut hours_total: HashMap<u32, usize> = HashMap::new();
        for ((y, day, hour), (cnt, lost, sum, ok)) in grid {
            if cnt < 20 {
                continue;
            }
            *hours_total.entry(hour).or_insert(0) += 1;
            let loss = lost as f64 * 100.0 / cnt as f64;
            let avg = (ok > 0).then(|| sum / ok as f64);
            let bad = loss > warn_loss || avg.map_or(false, |a| bad_ms.is_finite() && bad_ms > 0.0 && a > bad_ms);
            if bad {
                bad_days.entry(hour).or_default().insert((y, day));
            }
        }
        let mut out: Vec<u8> = bad_days
            .into_iter()
            .filter(|(h, days)| days.len() >= 3 && days.len() * 2 >= *hours_total.get(h).unwrap_or(&0))
            .map(|(h, _)| h as u8)
            .collect();
        out.sort_unstable();
        // Плохо почти всегда — это не «часы пик», а постоянная проблема.
        if out.len() > 8 {
            out.clear();
        }
        Ok(out)
    }

    /// Досчитать минутные агрегаты за последние `minutes` минут (для отчётов «до текущей минуты»).
    pub fn rollup_recent(&self, now: i64, minutes: i64) -> Result<()> {
        let since = (now - minutes * 60_000) / 60_000 * 60_000;
        self.conn.lock().execute(
            "INSERT OR REPLACE INTO rollup(target_id, ts, cnt, lost, min, avg, max)
             SELECT target_id, (ts / 60000) * 60000 AS m, COUNT(*), SUM(rtt IS NULL), MIN(rtt), AVG(rtt), MAX(rtt)
             FROM samples WHERE ts >= ?1 GROUP BY target_id, m",
            [since],
        )?;
        Ok(())
    }

    /// Агрегация и очистка по ретеншну.
    pub fn maintenance(&self, settings: &Settings, now: i64) -> Result<()> {
        let c = self.conn.lock();
        // Агрегируем всё, что ещё не сагрегировано: после сна компьютера или долгой паузы
        // приложения «дыра» иначе удалялась бы вместе с сырыми данными.
        let last_rollup: Option<i64> = c.query_row("SELECT MAX(ts) FROM rollup", [], |r| r.get(0)).optional()?.flatten();
        let since = last_rollup.map_or_else(|| (now - 20 * 60_000) / 60_000 * 60_000, |t| t.min(now - 20 * 60_000));
        c.execute(
            "INSERT OR REPLACE INTO rollup(target_id, ts, cnt, lost, min, avg, max)
             SELECT target_id, (ts / 60000) * 60000 AS m, COUNT(*), SUM(rtt IS NULL), MIN(rtt), AVG(rtt), MAX(rtt)
             FROM samples WHERE ts >= ?1 GROUP BY target_id, m",
            [since],
        )?;
        let raw_cut = now - settings.retention_raw_hours.max(1) as i64 * 3_600_000;
        c.execute("DELETE FROM samples WHERE ts < ?1", [raw_cut])?;
        let roll_cut = now - settings.retention_rollup_days.max(1) as i64 * 86_400_000;
        c.execute("DELETE FROM rollup WHERE ts < ?1", [roll_cut])?;
        c.execute("DELETE FROM events WHERE ts < ?1", [now - 365 * 86_400_000i64])?;
        Ok(())
    }

    // ------------------------------------------------------------ events

    pub fn insert_event(&self, e: &EventRecord) -> Result<i64> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO events(ts, target_id, target_name, kind, severity, message) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![e.ts, e.target_id, e.target_name, e.kind, e.severity, e.message],
        )?;
        Ok(c.last_insert_rowid())
    }

    pub fn events(&self, limit: usize, target_id: Option<&str>) -> Result<Vec<EventRecord>> {
        let c = self.conn.lock();
        let mut st = c.prepare_cached(
            "SELECT id, ts, target_id, target_name, kind, severity, message FROM events
             WHERE (?1 IS NULL OR target_id = ?1) ORDER BY ts DESC, id DESC LIMIT ?2",
        )?;
        let rows = st.query_map(params![target_id, limit as i64], |r| {
            Ok(EventRecord {
                id: r.get(0)?,
                ts: r.get(1)?,
                target_id: r.get(2)?,
                target_name: r.get(3)?,
                kind: r.get(4)?,
                severity: r.get(5)?,
                message: r.get(6)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn clear_events(&self) -> Result<()> {
        self.conn.lock().execute("DELETE FROM events", [])?;
        Ok(())
    }

    /// Полная очистка истории измерений (и, по желанию, событий). Цели и настройки не трогаются.
    pub fn clear_history(&self, with_events: bool) -> Result<()> {
        let mut c = self.conn.lock();
        {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM samples", [])?;
            tx.execute("DELETE FROM rollup", [])?;
            if with_events {
                tx.execute("DELETE FROM events", [])?;
            }
            tx.commit()?;
        }
        // Возвращаем место на диске.
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")?;
        Ok(())
    }

    /// (число сэмплов, число минутных агрегатов, число событий, размер файла БД в байтах)
    pub fn history_stats(&self) -> Result<(i64, i64, i64, i64)> {
        let c = self.conn.lock();
        let samples: i64 = c.query_row("SELECT COUNT(*) FROM samples", [], |r| r.get(0))?;
        let rollup: i64 = c.query_row("SELECT COUNT(*) FROM rollup", [], |r| r.get(0))?;
        let events: i64 = c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0))?;
        let size: i64 = c.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        Ok((samples, rollup, events, pages * size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hops_roundtrip() {
        let h = vec![
            HopSample { ttl: 1, addr: Some("192.168.1.1".parse().unwrap()), rtt_ms: Some(1.5) },
            HopSample { ttl: 2, addr: None, rtt_ms: None },
            HopSample { ttl: 3, addr: Some("2001:db8::1".parse().unwrap()), rtt_ms: Some(20.0) },
        ];
        assert_eq!(decode_hops(&encode_hops(&h)), h);
    }

    #[test]
    fn samples_and_rollup() {
        let st = Storage::in_memory().unwrap();
        for i in 0..120 {
            st.insert_sample(
                "t",
                &Sample { ts: i * 1000, rtt_ms: (i % 4 != 0).then_some(10.0), status_code: None, error: None, hops: vec![] },
            )
            .unwrap();
        }
        assert_eq!(st.samples_range("t", 0, 59_999).unwrap().len(), 60);
        st.maintenance(&Settings::default(), 120_000).unwrap();
        let tl = st.rollup_timeline("t", 0, 120_000, 10).unwrap();
        assert_eq!(tl.len(), 2);
        assert!((tl[0].loss_pct - 25.0).abs() < 0.1);
        assert!((st.uptime("t", 0).unwrap().unwrap() - 75.0).abs() < 0.1);
    }
}
