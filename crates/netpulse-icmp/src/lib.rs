//! Кроссплатформенный ICMP-пробер без прав администратора.
//!
//! * macOS  — `SOCK_DGRAM` + `IPPROTO_ICMP` (не требует root), fallback на RAW.
//! * Linux  — RAW (если есть CAP_NET_RAW/root), иначе `SOCK_DGRAM` (только ping, без хопов).
//! * Windows — `IcmpSendEcho2Ex` / `Icmp6SendEcho2` из iphlpapi (не требует админа).
//!
//! Главный API: [`Pinger::probe`] — отправить один echo-запрос с заданным TTL и
//! дождаться ответа (echo reply от цели или time exceeded от промежуточного узла).

use std::net::IpAddr;
use std::time::Duration;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

pub(crate) mod packet;

#[derive(Debug, thiserror::Error)]
pub enum IcmpError {
    #[error("не удалось открыть ICMP-сокет: {0}")]
    Socket(String),
    #[error("ошибка отправки: {0}")]
    Send(String),
    #[error("IPv6 не поддерживается на этой платформе")]
    Unsupported,
}

/// Тип ответа.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyKind {
    /// Эхо-ответ от цели.
    Echo,
    /// TTL истёк на промежуточном узле.
    TimeExceeded,
    /// Узел/сеть недоступны (ответ маршрутизатора).
    Unreachable,
}

/// Почему маршрутизатор ответил «недоступен».
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unreachable {
    /// Нет маршрута до сети.
    Network,
    /// Сеть известна, но узел не отвечает (нет ARP).
    Host,
    /// Протокол не поддерживается.
    Protocol,
    /// Порт закрыт.
    Port,
    /// Пакет больше MTU, а фрагментация запрещена.
    FragmentationNeeded,
    /// Запрещено административно (фильтр, ACL).
    Prohibited,
    /// Другой код.
    Other(u8),
}

impl Unreachable {
    pub fn from_code(code: u8) -> Self {
        match code {
            0 => Self::Network,
            1 => Self::Host,
            2 => Self::Protocol,
            3 => Self::Port,
            4 => Self::FragmentationNeeded,
            9 | 10 | 13 => Self::Prohibited,
            c => Self::Other(c),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Reply {
    pub from: IpAddr,
    pub rtt: Duration,
    pub kind: ReplyKind,
    /// Для ReplyKind::Unreachable — причина недоступности.
    pub unreachable: Option<Unreachable>,
}

/// Кроссплатформенный пингер. Дёшево клонируется (внутри Arc).
#[derive(Clone)]
pub struct Pinger {
    #[cfg(unix)]
    inner: std::sync::Arc<unix::UnixPinger>,
    #[cfg(windows)]
    inner: std::sync::Arc<windows::WinPinger>,
}

impl Pinger {
    /// Создаёт пингер. Должен вызываться внутри tokio runtime.
    pub fn new() -> Result<Self, IcmpError> {
        #[cfg(unix)]
        {
            Ok(Self { inner: std::sync::Arc::new(unix::UnixPinger::new()?) })
        }
        #[cfg(windows)]
        {
            Ok(Self { inner: std::sync::Arc::new(windows::WinPinger::new()?) })
        }
    }

    /// Поддерживает ли текущий режим получение Time Exceeded (трассировку).
    pub fn supports_trace(&self) -> bool {
        self.inner.supports_trace()
    }

    /// Описание режима работы (для диагностики в UI).
    pub fn mode(&self) -> String {
        self.inner.mode()
    }

    /// Один probe. `Ok(None)` — таймаут (пакет потерян).
    pub async fn probe(
        &self,
        dst: IpAddr,
        ttl: u8,
        payload_size: u16,
        timeout: Duration,
    ) -> Result<Option<Reply>, IcmpError> {
        self.inner.probe(dst, ttl, payload_size, timeout).await
    }
}
