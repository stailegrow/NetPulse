use crate::packet::{self, Parsed};
use crate::{IcmpError, Reply, ReplyKind};
use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use std::collections::HashMap;
use std::mem::MaybeUninit;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::unix::AsyncFd;
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Dgram,
    Raw,
}

struct PendingEntry {
    dst: IpAddr,
    tx: oneshot::Sender<Reply>,
    sent: Instant,
}

struct Shared {
    id: u16,
    kind: Kind,
    pending: Mutex<HashMap<(bool, u16), PendingEntry>>,
}

pub(crate) struct UnixPinger {
    shared: Arc<Shared>,
    seq: AtomicU16,
    /// Сокеты по (v6, ttl): у каждого фиксированный TTL, чтобы параллельные
    /// пробы с разным TTL не конфликтовали.
    sockets: Mutex<HashMap<(bool, u8), Arc<AsyncFd<Socket>>>>,
}

fn open(v6: bool, kind: Kind) -> std::io::Result<Socket> {
    let (domain, proto) = if v6 {
        (Domain::IPV6, Protocol::ICMPV6)
    } else {
        (Domain::IPV4, Protocol::ICMPV4)
    };
    let ty = match kind {
        Kind::Dgram => Type::DGRAM,
        Kind::Raw => Type::RAW,
    };
    let s = Socket::new(domain, ty, Some(proto))?;
    s.set_nonblocking(true)?;
    Ok(s)
}

impl UnixPinger {
    pub fn new() -> Result<Self, IcmpError> {
        let order: &[Kind] = if cfg!(target_os = "linux") {
            &[Kind::Raw, Kind::Dgram]
        } else {
            &[Kind::Dgram, Kind::Raw]
        };
        let mut last_err = String::new();
        let mut kind = None;
        for k in order {
            match open(false, *k) {
                Ok(_) => {
                    kind = Some(*k);
                    break;
                }
                Err(e) => last_err = e.to_string(),
            }
        }
        let kind = kind.ok_or(IcmpError::Socket(last_err))?;
        Ok(Self {
            shared: Arc::new(Shared {
                id: (std::process::id() & 0xffff) as u16,
                kind,
                pending: Mutex::new(HashMap::new()),
            }),
            seq: AtomicU16::new(1),
            sockets: Mutex::new(HashMap::new()),
        })
    }

    pub fn supports_trace(&self) -> bool {
        !(cfg!(target_os = "linux") && self.shared.kind == Kind::Dgram)
    }

    pub fn mode(&self) -> String {
        format!("unix/{:?}", self.shared.kind)
    }

    fn socket(&self, v6: bool, ttl: u8) -> Result<Arc<AsyncFd<Socket>>, IcmpError> {
        let mut map = self.sockets.lock().unwrap();
        if let Some(s) = map.get(&(v6, ttl)) {
            return Ok(s.clone());
        }
        let s = open(v6, self.shared.kind).map_err(|e| IcmpError::Socket(e.to_string()))?;
        let r = if v6 { s.set_unicast_hops_v6(ttl as u32) } else { s.set_ttl(ttl as u32) };
        r.map_err(|e| IcmpError::Socket(e.to_string()))?;
        let fd = Arc::new(AsyncFd::new(s).map_err(|e| IcmpError::Socket(e.to_string()))?);
        map.insert((v6, ttl), fd.clone());
        tokio::spawn(recv_loop(fd.clone(), v6, self.shared.clone()));
        Ok(fd)
    }

    fn next_seq(&self, v6: bool) -> u16 {
        let pending = self.shared.pending.lock().unwrap();
        loop {
            let s = self.seq.fetch_add(1, Ordering::Relaxed);
            if s != 0 && !pending.contains_key(&(v6, s)) {
                return s;
            }
        }
    }

    pub async fn probe(
        &self,
        dst: IpAddr,
        ttl: u8,
        payload_size: u16,
        timeout: Duration,
    ) -> Result<Option<Reply>, IcmpError> {
        let v6 = dst.is_ipv6();
        let sock = self.socket(v6, ttl.max(1))?;
        let seq = self.next_seq(v6);
        let pkt = packet::build_echo(v6, self.shared.id, seq, payload_size);
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending
            .lock()
            .unwrap()
            .insert((v6, seq), PendingEntry { dst, tx, sent: Instant::now() });

        let addr = SockAddr::from(SocketAddr::new(dst, 0));
        let send_res = loop {
            let mut guard = match sock.writable().await {
                Ok(g) => g,
                Err(e) => break Err(e),
            };
            match guard.try_io(|s| s.get_ref().send_to(&pkt, &addr)) {
                Ok(r) => break r,
                Err(_would_block) => continue,
            }
        };
        if let Some(e) = send_res.err() {
            self.shared.pending.lock().unwrap().remove(&(v6, seq));
            // Сеть недоступна/нет маршрута — считаем как потерю, а не фатальную ошибку.
            return match e.raw_os_error() {
                Some(libc::ENETUNREACH) | Some(libc::EHOSTUNREACH) | Some(libc::EHOSTDOWN) => Ok(None),
                _ => Err(IcmpError::Send(e.to_string())),
            };
        }
        // Обновляем время отправки максимально близко к фактической отправке.
        if let Some(p) = self.shared.pending.lock().unwrap().get_mut(&(v6, seq)) {
            p.sent = Instant::now();
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => Ok(Some(reply)),
            _ => {
                self.shared.pending.lock().unwrap().remove(&(v6, seq));
                Ok(None)
            }
        }
    }
}

async fn recv_loop(fd: Arc<AsyncFd<Socket>>, v6: bool, shared: Arc<Shared>) {
    let mut buf = vec![0u8; 2048];
    loop {
        let mut guard = match fd.readable().await {
            Ok(g) => g,
            Err(_) => return,
        };
        let res = guard.try_io(|s| {
            // SAFETY: MaybeUninit<u8> и u8 имеют одинаковое представление.
            let uninit: &mut [MaybeUninit<u8>] =
                unsafe { &mut *(buf.as_mut_slice() as *mut [u8] as *mut [MaybeUninit<u8>]) };
            s.get_ref().recv_from(uninit)
        });
        let (n, from) = match res {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => continue,
            Err(_would_block) => continue,
        };
        let now = Instant::now();
        let Some(from) = from.as_socket().map(|a| a.ip()) else { continue };
        let parsed = if v6 { packet::parse_v6(&buf[..n]) } else { packet::parse_v4(&buf[..n]) };
        let Some(parsed) = parsed else { continue };
        let (id, seq, kind, unreach) = match parsed {
            Parsed::Echo { id, seq } => (id, seq, ReplyKind::Echo, None),
            Parsed::TimeExceeded { id, seq } => (id, seq, ReplyKind::TimeExceeded, None),
            Parsed::Unreachable { id, seq, code } => (id, seq, ReplyKind::Unreachable, Some(crate::Unreachable::from_code(code))),
        };
        // В RAW-режиме сокет видит ICMP всех процессов — фильтруем по идентификатору.
        // В DGRAM-режиме ядро может переписывать id, поэтому сверяем seq + адрес.
        if shared.kind == Kind::Raw && id != shared.id {
            continue;
        }
        let mut pending = shared.pending.lock().unwrap();
        let matches = match pending.get(&(v6, seq)) {
            Some(p) => kind != ReplyKind::Echo || p.dst == from,
            None => false,
        };
        if matches {
            if let Some(p) = pending.remove(&(v6, seq)) {
                let rtt = now.saturating_duration_since(p.sent);
                let _ = p.tx.send(Reply { from, rtt, kind, unreachable: unreach });
            }
        }
    }
}
