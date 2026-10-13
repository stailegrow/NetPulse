//! Лицензия: бесплатная версия — до 10 узлов и только базовый мониторинг,
//! с ключом — всё (дашборд, инциденты, карта сети, отчёты, операторы).

/// Сколько целей можно держать без ключа.
pub const FREE_TARGET_LIMIT: usize = 10;

const SALT: &str = "netpulse/license/v1:";
/// Отпечатки действующих ключей (сам ключ в программе не хранится).
const KEYS: &[u64] = &[0xe3ef1cb8f5ecfaf3];

fn fnv(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for x in b {
        h ^= *x as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Ключ без пробелов и дефисов, в верхнем регистре.
pub fn normalize(key: &str) -> String {
    key.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn fingerprint(key: &str) -> u64 {
    let k = format!("{SALT}{}", normalize(key));
    let mut h = fnv(k.as_bytes());
    for _ in 0..1000 {
        h = fnv(format!("{h:#x}{k}").as_bytes());
    }
    h
}

pub fn key_valid(key: &str) -> bool {
    let n = normalize(key);
    n.len() == 16 && KEYS.contains(&fingerprint(&n))
}

/// Ключ для показа: первые четыре знака, остальное скрыто.
pub fn mask(key: &str) -> String {
    let n = normalize(key);
    if n.len() < 4 {
        return String::new();
    }
    format!("{}-••••-••••-{}", &n[..4], &n[n.len() - 4..])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn format_and_reject() {
        assert!(!key_valid("AAAA-BBBB-CCCC-DDDD"));
        assert!(!key_valid(""));
        assert!(!key_valid("short"));
        assert_eq!(normalize(" ab12-cd34 ef56-gh78 "), "AB12CD34EF56GH78");
        assert_eq!(mask("ab12-cd34-ef56-gh78"), "AB12-••••-••••-GH78");
    }
}
