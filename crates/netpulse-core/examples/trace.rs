//! Отладка трассировки из терминала:
//! `cargo run -p netpulse-core --example trace -- 8.8.8.8`
use netpulse_core::checks;
use netpulse_core::icmp::Pinger;
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let host = std::env::args().nth(1).unwrap_or_else(|| "1.1.1.1".into());
    let rounds: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(3);
    let pinger = Pinger::new()?;
    let ip = checks::resolve(&host).await?;
    println!("NetPulse trace {host} ({ip}), режим ICMP: {}", pinger.mode());
    let mut max = 30;
    for round in 1..=rounds {
        let r = checks::trace_round(&pinger, ip, max, 56, Duration::from_secs(2)).await;
        if let Some(n) = r.reached_ttl {
            max = n;
        }
        println!("--- раунд {round}");
        for h in &r.hops {
            let name = match h.addr {
                Some(a) => checks::reverse_dns(a).await.unwrap_or_default(),
                None => String::new(),
            };
            println!(
                "{:>3}  {:<40} {:<40} {}",
                h.ttl,
                h.addr.map(|a| a.to_string()).unwrap_or_else(|| "*".into()),
                name,
                h.rtt_ms.map(|v| format!("{v:.1} ms")).unwrap_or_else(|| "*".into())
            );
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    Ok(())
}
