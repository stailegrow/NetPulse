//! Сквозная проверка движка без UI: `cargo run -p netpulse-core --example engine`
use netpulse_core::model::{CheckKind, Target};
use netpulse_core::storage::Storage;
use netpulse_core::Monitor;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let m = Monitor::start_with_storage(Arc::new(Storage::in_memory()?), "memory".into())?;
    println!("{:?}", m.engine_info());
    let mk = |name: &str, host: &str, kind: CheckKind, port: Option<u16>| Target {
        name: name.into(), host: host.into(), kind, port, interval_ms: 1000, timeout_ms: 1500, ..Default::default()
    };
    let tr = m.upsert_target(mk("localhost trace", "127.0.0.1", CheckKind::Trace, None))?;
    m.upsert_target(mk("dead host", "192.0.2.123", CheckKind::Ping, None))?;
    m.upsert_target(mk("http", "https://example.com", CheckKind::Http, None))?;
    m.upsert_target(mk("tcp", "127.0.0.1", CheckKind::Tcp, Some(1)))?;
    m.upsert_target(mk("dns", "localhost", CheckKind::Dns, None))?;
    let mut rx = m.subscribe();
    tokio::spawn(async move { while let Ok(a) = rx.recv().await { println!("ALERT: {}", a.message); } });
    tokio::time::sleep(Duration::from_secs(7)).await;
    for s in m.summaries() {
        println!("{:<16} {:?} last={:?} avg={:?} loss={:.0}% code={:?} err={:?} samples={}", s.name, s.health, s.last_rtt, s.avg_rtt, s.loss_pct, s.status_code, s.last_error, s.samples);
    }
    let now = netpulse_core::checks::now_ms();
    let v = m.trace_view(&tr.id, now - 60_000, now)?;
    println!("trace: {} samples, hops={:?}", v.samples, v.hops.iter().map(|h| (h.ttl, h.addr.clone(), h.avg)).collect::<Vec<_>>());
    println!("timeline pts: {}", m.timeline(&tr.id, None, now - 60_000, now, 30)?.len());
    println!("events: {}", m.events(10, None)?.len());
    println!("csv lines: {}", m.export_csv(&tr.id, now - 60_000, now)?.lines().count());
    Ok(())
}
