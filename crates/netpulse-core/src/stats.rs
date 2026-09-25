use crate::model::{HopStats, Sample, TimelinePoint};
use std::collections::BTreeMap;
use std::net::IpAddr;

#[derive(Default, Clone)]
pub struct Acc {
    pub sent: u32,
    pub lost: u32,
    pub min: Option<f32>,
    pub max: Option<f32>,
    pub sum: f64,
    pub cur: Option<f32>,
    prev: Option<f32>,
    jitter_sum: f64,
    jitter_n: u32,
    pub addr: Option<IpAddr>,
}

impl Acc {
    pub fn push(&mut self, rtt: Option<f32>) {
        self.sent += 1;
        self.cur = rtt;
        match rtt {
            None => self.lost += 1,
            Some(v) => {
                self.sum += v as f64;
                self.min = Some(self.min.map_or(v, |m| m.min(v)));
                self.max = Some(self.max.map_or(v, |m| m.max(v)));
                if let Some(p) = self.prev {
                    self.jitter_sum += (v - p).abs() as f64;
                    self.jitter_n += 1;
                }
                self.prev = Some(v);
            }
        }
    }
    pub fn received(&self) -> u32 {
        self.sent - self.lost
    }
    pub fn avg(&self) -> Option<f32> {
        (self.received() > 0).then(|| (self.sum / self.received() as f64) as f32)
    }
    pub fn loss_pct(&self) -> f32 {
        if self.sent == 0 {
            0.0
        } else {
            self.lost as f32 * 100.0 / self.sent as f32
        }
    }
    pub fn jitter(&self) -> Option<f32> {
        (self.jitter_n > 0).then(|| (self.jitter_sum / self.jitter_n as f64) as f32)
    }
    pub fn to_hop(&self, ttl: u8) -> HopStats {
        HopStats {
            ttl,
            addr: self.addr.map(|a| a.to_string()),
            hostname: None,
            sent: self.sent,
            lost: self.lost,
            loss_pct: self.loss_pct(),
            min: self.min,
            avg: self.avg(),
            max: self.max,
            cur: self.cur,
            jitter: self.jitter(),
            suspect: false,
        }
    }
}

/// Статистика по хопам и по конечной цели за набор сэмплов.
pub fn trace_stats<'a>(samples: impl IntoIterator<Item = &'a Sample>) -> (Vec<HopStats>, HopStats) {
    let mut hops: BTreeMap<u8, Acc> = BTreeMap::new();
    let mut fin = Acc::default();
    for s in samples {
        fin.push(s.rtt_ms);
        for h in &s.hops {
            let a = hops.entry(h.ttl).or_default();
            a.push(h.rtt_ms);
            if h.addr.is_some() {
                a.addr = h.addr;
            }
        }
        if let Some(last) = s.hops.last() {
            if last.addr.is_some() {
                fin.addr = last.addr;
            }
        }
    }
    let mut out: Vec<HopStats> = hops.iter().map(|(ttl, a)| a.to_hop(*ttl)).collect();
    mark_suspect(&mut out, fin.loss_pct());
    (out, fin.to_hop(0))
}

/// Помечает хоп, начиная с которого потери доходят до цели.
/// Потери на промежуточном хопе, которые не продолжаются дальше, — обычно
/// просто ограничение ICMP на маршрутизаторе, их игнорируем.
pub fn mark_suspect(hops: &mut [HopStats], final_loss: f32) {
    if final_loss < 1.0 || hops.is_empty() {
        return;
    }
    let bar = final_loss * 0.6;
    for i in 0..hops.len() {
        if hops[i].loss_pct >= bar && hops[i..].iter().all(|h| h.loss_pct >= bar || h.sent == 0) {
            hops[i].suspect = true;
            return;
        }
    }
}

/// Оценка качества голосовой связи (MOS 1..4.5) по E-model (упрощённо).
pub fn mos(avg_ms: f32, jitter_ms: f32, loss_pct: f32) -> f32 {
    let eff = avg_ms + jitter_ms * 2.0 + 10.0;
    let mut r = if eff < 160.0 { 93.2 - eff / 40.0 } else { 93.2 - (eff - 120.0) / 10.0 };
    r -= loss_pct * 2.5;
    let r = r.clamp(0.0, 100.0);
    (1.0 + 0.035 * r + 0.000007 * r * (r - 60.0) * (100.0 - r)).clamp(1.0, 4.5)
}

/// Бакетирование сэмплов в точки таймлайна. `ttl = None` — конечная цель.
pub fn bucketize<'a>(
    samples: impl IntoIterator<Item = &'a Sample>,
    ttl: Option<u8>,
    from: i64,
    to: i64,
    points: usize,
) -> Vec<TimelinePoint> {
    let points = points.max(1);
    let step = ((to - from) as f64 / points as f64).max(1.0);
    let mut buckets: BTreeMap<i64, Acc> = BTreeMap::new();
    for s in samples {
        if s.ts < from || s.ts > to {
            continue;
        }
        let rtt = match ttl {
            None => Some(s.rtt_ms),
            Some(t) => s.hops.iter().find(|h| h.ttl == t).map(|h| h.rtt_ms),
        };
        let Some(rtt) = rtt else { continue };
        let idx = ((s.ts - from) as f64 / step) as i64;
        buckets.entry(idx).or_default().push(rtt);
    }
    buckets
        .into_iter()
        .map(|(idx, a)| TimelinePoint {
            ts: from + (idx as f64 * step) as i64,
            avg: a.avg(),
            min: a.min,
            max: a.max,
            loss_pct: a.loss_pct(),
            count: a.sent,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::HopSample;

    fn s(ts: i64, hops: &[(u8, Option<f32>)], fin: Option<f32>) -> Sample {
        Sample {
            ts,
            rtt_ms: fin,
            status_code: None,
            error: None,
            hops: hops
                .iter()
                .map(|(t, r)| HopSample { ttl: *t, addr: Some("10.0.0.1".parse().unwrap()), rtt_ms: *r })
                .collect(),
        }
    }

    #[test]
    fn stats_and_suspect() {
        let v = vec![
            s(0, &[(1, Some(1.0)), (2, None), (3, None)], None),
            s(1, &[(1, Some(3.0)), (2, Some(10.0)), (3, Some(20.0))], Some(20.0)),
            s(2, &[(1, Some(2.0)), (2, None), (3, None)], None),
        ];
        let (hops, fin) = trace_stats(&v);
        assert_eq!(hops.len(), 3);
        assert_eq!(hops[0].avg, Some(2.0));
        assert_eq!(hops[0].jitter, Some(1.5));
        assert!((fin.loss_pct - 66.66).abs() < 0.1);
        assert!(hops[1].suspect);
        assert!(!hops[0].suspect);
    }

    #[test]
    fn mos_range() {
        assert!(mos(20.0, 2.0, 0.0) > 4.3);
        assert!(mos(400.0, 50.0, 10.0) < 3.0);
    }

    #[test]
    fn buckets() {
        let v: Vec<Sample> = (0..100).map(|i| s(i * 10, &[], if i % 10 == 0 { None } else { Some(5.0) })).collect();
        let b = bucketize(&v, None, 0, 1000, 10);
        assert_eq!(b.len(), 10);
        assert!((b[0].loss_pct - 10.0).abs() < 0.01);
    }

    #[test]
    fn threshold_levels() {
        use crate::model::Thresholds;
        let t = Thresholds::default();
        assert_eq!([5.3, 10.0, 10.1, 30.0, 45.0, 50.0, 51.0].map(|v| t.latency_level(v)), [0, 0, 1, 1, 2, 2, 3]);
        assert_eq!([0.0, 5.0, 5.1, 10.0, 10.1].map(|v| t.loss_level(v)), [0, 0, 1, 1, 3]);
        let legacy = Thresholds { warn_ms: 100.0, bad_ms: 250.0, crit_ms: 500.0, warn_loss: 5.0, bad_loss: 10.0, ..Default::default() };
        assert_eq!(legacy.normalized(), Thresholds::default());
        assert_eq!(legacy.normalized_for(crate::model::CheckKind::Http), Thresholds::http_default());
        let http = Thresholds { warn_ms: 500.0, bad_ms: 1500.0, crit_ms: 50.0, warn_loss: 2.0, bad_loss: 10.0, ..Default::default() };
        assert_eq!(http.normalized().crit_ms, 3000.0);
    }
}
