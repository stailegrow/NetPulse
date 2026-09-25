use crate::{IcmpError, Reply, ReplyKind};
use std::ffi::c_void;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    Icmp6CreateFile, Icmp6ParseReplies, Icmp6SendEcho2, IcmpCloseHandle, IcmpCreateFile,
    IcmpSendEcho2Ex, ICMPV6_ECHO_REPLY_LH, ICMP_ECHO_REPLY, IP_OPTION_INFORMATION,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET6, SOCKADDR_IN6};

const IP_SUCCESS: u32 = 0;
const IP_DEST_NET_UNREACHABLE: u32 = 11002;
const IP_DEST_HOST_UNREACHABLE: u32 = 11003;
const IP_DEST_PROT_UNREACHABLE: u32 = 11004;
const IP_DEST_PORT_UNREACHABLE: u32 = 11005;
const IP_PACKET_TOO_BIG: u32 = 11009;
const IP_DEST_PROHIBITED: u32 = 11040;
const IP_TTL_EXPIRED_TRANSIT: u32 = 11013;
const IP_TTL_EXPIRED_REASSEM: u32 = 11014;
const SENTINEL: u32 = 0xFFFF_FFFF;

#[derive(Clone, Copy)]
struct Handle(HANDLE);
// SAFETY: ICMP handle из iphlpapi потокобезопасен для параллельных вызовов.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

pub(crate) struct WinPinger {
    h4: Handle,
    h6: Option<Handle>,
}

impl Drop for WinPinger {
    fn drop(&mut self) {
        unsafe {
            IcmpCloseHandle(self.h4.0);
            if let Some(h) = self.h6 {
                IcmpCloseHandle(h.0);
            }
        }
    }
}

fn classify(status: u32) -> Option<(ReplyKind, Option<crate::Unreachable>)> {
    use crate::Unreachable as U;
    match status {
        IP_SUCCESS => Some((ReplyKind::Echo, None)),
        IP_TTL_EXPIRED_TRANSIT | IP_TTL_EXPIRED_REASSEM => Some((ReplyKind::TimeExceeded, None)),
        IP_DEST_NET_UNREACHABLE => Some((ReplyKind::Unreachable, Some(U::Network))),
        IP_DEST_HOST_UNREACHABLE => Some((ReplyKind::Unreachable, Some(U::Host))),
        IP_DEST_PROT_UNREACHABLE => Some((ReplyKind::Unreachable, Some(U::Protocol))),
        IP_DEST_PORT_UNREACHABLE => Some((ReplyKind::Unreachable, Some(U::Port))),
        IP_PACKET_TOO_BIG => Some((ReplyKind::Unreachable, Some(U::FragmentationNeeded))),
        IP_DEST_PROHIBITED => Some((ReplyKind::Unreachable, Some(U::Prohibited))),
        _ => None,
    }
}

impl WinPinger {
    pub fn new() -> Result<Self, IcmpError> {
        let h4 = unsafe { IcmpCreateFile() };
        if h4 == INVALID_HANDLE_VALUE || h4.is_null() {
            return Err(IcmpError::Socket("IcmpCreateFile failed".into()));
        }
        let h6 = unsafe { Icmp6CreateFile() };
        let h6 = if h6 == INVALID_HANDLE_VALUE || h6.is_null() { None } else { Some(Handle(h6)) };
        Ok(Self { h4: Handle(h4), h6 })
    }

    pub fn supports_trace(&self) -> bool {
        true
    }

    pub fn mode(&self) -> String {
        "windows/iphlpapi".into()
    }

    pub async fn probe(
        &self,
        dst: IpAddr,
        ttl: u8,
        payload_size: u16,
        timeout: Duration,
    ) -> Result<Option<Reply>, IcmpError> {
        let timeout_ms = timeout.as_millis().clamp(1, u32::MAX as u128) as u32;
        let size = payload_size;
        match dst {
            IpAddr::V4(v4) => {
                let h = self.h4;
                tokio::task::spawn_blocking(move || probe_v4(h, v4, ttl, size, timeout_ms))
                    .await
                    .map_err(|e| IcmpError::Send(e.to_string()))
            }
            IpAddr::V6(v6) => {
                let h = self.h6.ok_or(IcmpError::Unsupported)?;
                tokio::task::spawn_blocking(move || probe_v6(h, v6, ttl, size, timeout_ms))
                    .await
                    .map_err(|e| IcmpError::Send(e.to_string()))
            }
        }
    }
}

fn payload(size: u16) -> Vec<u8> {
    (0..size as usize).map(|i| b"NetPulse"[i % 8]).collect()
}

fn probe_v4(h: Handle, dst: Ipv4Addr, ttl: u8, size: u16, timeout_ms: u32) -> Option<Reply> {
    let data = payload(size);
    let reply_size = std::mem::size_of::<ICMP_ECHO_REPLY>() + size as usize + 256;
    let mut buf = vec![0u8; reply_size];
    let opts = IP_OPTION_INFORMATION {
        Ttl: ttl.max(1),
        Tos: 0,
        Flags: 0,
        OptionsSize: 0,
        OptionsData: std::ptr::null_mut(),
    };
    // Sentinel в поле Status, чтобы отличить «ответа нет» от IP_SUCCESS (0).
    unsafe {
        let r = buf.as_mut_ptr() as *mut ICMP_ECHO_REPLY;
        (*r).Status = SENTINEL;
    }
    let started = Instant::now();
    let _count = unsafe {
        IcmpSendEcho2Ex(
            h.0,
            std::ptr::null_mut(),
            None,
            std::ptr::null(),
            0,
            u32::from_ne_bytes(dst.octets()),
            data.as_ptr() as *const c_void,
            size,
            &opts,
            buf.as_mut_ptr() as *mut c_void,
            reply_size as u32,
            timeout_ms,
        )
    };
    let rtt = started.elapsed();
    let reply = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const ICMP_ECHO_REPLY) };
    if reply.Status == SENTINEL {
        return None;
    }
    let (kind, unreachable) = classify(reply.Status)?;
    let from = Ipv4Addr::from(reply.Address.to_ne_bytes());
    if from.is_unspecified() {
        return None;
    }
    Some(Reply { from: IpAddr::V4(from), rtt, kind, unreachable })
}

fn probe_v6(h: Handle, dst: Ipv6Addr, ttl: u8, size: u16, timeout_ms: u32) -> Option<Reply> {
    let data = payload(size);
    let reply_size = std::mem::size_of::<ICMPV6_ECHO_REPLY_LH>() + size as usize + 256;
    let mut buf = vec![0u8; reply_size];
    let opts = IP_OPTION_INFORMATION {
        Ttl: ttl.max(1),
        Tos: 0,
        Flags: 0,
        OptionsSize: 0,
        OptionsData: std::ptr::null_mut(),
    };
    let mut src: SOCKADDR_IN6 = unsafe { std::mem::zeroed() };
    src.sin6_family = AF_INET6;
    let mut dest: SOCKADDR_IN6 = unsafe { std::mem::zeroed() };
    dest.sin6_family = AF_INET6;
    dest.sin6_addr.u.Byte = dst.octets();
    unsafe {
        let r = buf.as_mut_ptr() as *mut ICMPV6_ECHO_REPLY_LH;
        (*r).Status = SENTINEL;
    }
    let started = Instant::now();
    unsafe {
        Icmp6SendEcho2(
            h.0,
            std::ptr::null_mut(),
            None,
            std::ptr::null(),
            &src,
            &dest,
            data.as_ptr() as *const c_void,
            size,
            &opts,
            buf.as_mut_ptr() as *mut c_void,
            reply_size as u32,
            timeout_ms,
        );
        Icmp6ParseReplies(buf.as_mut_ptr() as *mut c_void, reply_size as u32);
    }
    let rtt = started.elapsed();
    let reply = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const ICMPV6_ECHO_REPLY_LH) };
    if reply.Status == SENTINEL {
        return None;
    }
    let (kind, unreachable) = classify(reply.Status)?;
    let words = reply.Address.sin6_addr;
    let mut octets = [0u8; 16];
    for (i, w) in words.iter().enumerate() {
        // sin6_addr хранится в сетевом порядке байт
        let b = w.to_ne_bytes();
        octets[i * 2] = b[0];
        octets[i * 2 + 1] = b[1];
    }
    let from = Ipv6Addr::from(octets);
    if from.is_unspecified() {
        return None;
    }
    Some(Reply { from: IpAddr::V6(from), rtt, kind, unreachable })
}
