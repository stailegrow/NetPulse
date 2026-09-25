//! Сборка и разбор ICMP-пакетов (используется в unix-реализации).
#![allow(dead_code)]

pub const ICMP4_ECHO_REQUEST: u8 = 8;
pub const ICMP4_ECHO_REPLY: u8 = 0;
pub const ICMP4_UNREACH: u8 = 3;
pub const ICMP4_TIME_EXCEEDED: u8 = 11;

pub const ICMP6_UNREACH: u8 = 1;
pub const ICMP6_TIME_EXCEEDED: u8 = 3;
pub const ICMP6_ECHO_REQUEST: u8 = 128;
pub const ICMP6_ECHO_REPLY: u8 = 129;

pub fn checksum(data: &[u8]) -> u16 {
    let mut sum: u32 = 0;
    let mut chunks = data.chunks_exact(2);
    for c in &mut chunks {
        sum += u16::from_be_bytes([c[0], c[1]]) as u32;
    }
    if let [b] = chunks.remainder() {
        sum += (*b as u32) << 8;
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

pub fn build_echo(v6: bool, id: u16, seq: u16, payload_size: u16) -> Vec<u8> {
    let mut p = vec![0u8; 8 + payload_size as usize];
    p[0] = if v6 { ICMP6_ECHO_REQUEST } else { ICMP4_ECHO_REQUEST };
    p[4..6].copy_from_slice(&id.to_be_bytes());
    p[6..8].copy_from_slice(&seq.to_be_bytes());
    for (i, b) in p[8..].iter_mut().enumerate() {
        *b = b"NetPulse"[i % 8];
    }
    if !v6 {
        let c = checksum(&p);
        p[2..4].copy_from_slice(&c.to_be_bytes());
    }
    p
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    Echo { id: u16, seq: u16 },
    TimeExceeded { id: u16, seq: u16 },
    /// `code` — код ICMP «недоступен»: 0 сеть, 1 узел, 3 порт, 4 нужна фрагментация, 13 запрещено.
    Unreachable { id: u16, seq: u16, code: u8 },
}

/// Разбор входящего IPv4 ICMP. Буфер может начинаться с IP-заголовка (RAW / macOS DGRAM)
/// или сразу с ICMP (Linux DGRAM).
pub fn parse_v4(buf: &[u8]) -> Option<Parsed> {
    let icmp = strip_ipv4(buf)?;
    if icmp.len() < 8 {
        return None;
    }
    match icmp[0] {
        ICMP4_ECHO_REPLY => Some(Parsed::Echo { id: be16(&icmp[4..6]), seq: be16(&icmp[6..8]) }),
        ICMP4_TIME_EXCEEDED | ICMP4_UNREACH => {
            let inner = strip_ipv4(&icmp[8..])?;
            if inner.len() < 8 || inner[0] != ICMP4_ECHO_REQUEST {
                return None;
            }
            let (id, seq) = (be16(&inner[4..6]), be16(&inner[6..8]));
            Some(if icmp[0] == ICMP4_TIME_EXCEEDED {
                Parsed::TimeExceeded { id, seq }
            } else {
                Parsed::Unreachable { id, seq, code: icmp[1] }
            })
        }
        _ => None,
    }
}

/// Разбор входящего ICMPv6 (ядро не отдаёт IPv6-заголовок).
pub fn parse_v6(icmp: &[u8]) -> Option<Parsed> {
    if icmp.len() < 8 {
        return None;
    }
    match icmp[0] {
        ICMP6_ECHO_REPLY => Some(Parsed::Echo { id: be16(&icmp[4..6]), seq: be16(&icmp[6..8]) }),
        ICMP6_TIME_EXCEEDED | ICMP6_UNREACH => {
            // 8 байт ICMPv6 + 40 байт исходного IPv6-заголовка
            let inner = icmp.get(48..)?;
            if inner.len() < 8 || inner[0] != ICMP6_ECHO_REQUEST {
                return None;
            }
            let (id, seq) = (be16(&inner[4..6]), be16(&inner[6..8]));
            Some(if icmp[0] == ICMP6_TIME_EXCEEDED {
                Parsed::TimeExceeded { id, seq }
            } else {
                // Коды ICMPv6 приводим к смыслу ICMPv4: 0 нет маршрута, 1 запрещено, 4 порт.
                let code = match icmp[1] {
                    0 => 0,
                    1 => 13,
                    4 => 3,
                    c => c,
                };
                Parsed::Unreachable { id, seq, code }
            })
        }
        _ => None,
    }
}

fn strip_ipv4(buf: &[u8]) -> Option<&[u8]> {
    let first = *buf.first()?;
    if first >> 4 == 4 {
        let ihl = ((first & 0x0f) as usize) * 4;
        buf.get(ihl..)
    } else {
        Some(buf)
    }
}

fn be16(b: &[u8]) -> u16 {
    u16::from_be_bytes([b[0], b[1]])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_roundtrip_checksum() {
        let p = build_echo(false, 0x1234, 7, 32);
        assert_eq!(checksum(&p), 0);
        let mut reply = p.clone();
        reply[0] = ICMP4_ECHO_REPLY;
        assert_eq!(parse_v4(&reply), Some(Parsed::Echo { id: 0x1234, seq: 7 }));
    }

    #[test]
    fn time_exceeded_with_ip_header() {
        let req = build_echo(false, 9, 42, 8);
        let mut inner_ip = vec![0x45u8; 1];
        inner_ip.extend_from_slice(&[0u8; 19]);
        let mut pkt = vec![0x45u8];
        pkt.extend_from_slice(&[0u8; 19]); // outer IP header
        pkt.extend_from_slice(&[ICMP4_TIME_EXCEEDED, 0, 0, 0, 0, 0, 0, 0]);
        pkt.extend_from_slice(&inner_ip);
        pkt.extend_from_slice(&req[..8]);
        assert_eq!(parse_v4(&pkt), Some(Parsed::TimeExceeded { id: 9, seq: 42 }));
    }

    #[test]
    fn v6_time_exceeded() {
        let req = build_echo(true, 1, 2, 8);
        let mut pkt = vec![ICMP6_TIME_EXCEEDED, 0, 0, 0, 0, 0, 0, 0];
        pkt.extend_from_slice(&[0u8; 40]);
        pkt.extend_from_slice(&req[..8]);
        assert_eq!(parse_v6(&pkt), Some(Parsed::TimeExceeded { id: 1, seq: 2 }));
    }
}
