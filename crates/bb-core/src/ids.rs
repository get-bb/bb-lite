use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngExt;

pub const GENERATED_ID_ALPHABET: &str = "23456789abcdefghijkmnpqrstuvwxyz";
pub const GENERATED_ID_SUFFIX_LENGTH: usize = 10;

pub fn new_id(prefix: &str) -> String {
    let alphabet = GENERATED_ID_ALPHABET.as_bytes();
    let mut rng = rand::rng();
    let mut id = String::with_capacity(prefix.len() + 1 + GENERATED_ID_SUFFIX_LENGTH);
    id.push_str(prefix);
    id.push('_');
    for _ in 0..GENERATED_ID_SUFFIX_LENGTH {
        let byte: u8 = rng.random();
        id.push(alphabet[byte as usize % alphabet.len()] as char);
    }
    id
}

pub fn random_hex(bytes: usize) -> String {
    let mut rng = rand::rng();
    let mut text = String::with_capacity(bytes * 2);
    for _ in 0..bytes {
        let byte: u8 = rng.random();
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

pub fn now_ms() -> i64 {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    elapsed.as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_have_prefix_and_alphabet() {
        let id = new_id("thr");
        let (prefix, suffix) = id.split_once('_').unwrap();
        assert_eq!(prefix, "thr");
        assert_eq!(suffix.len(), GENERATED_ID_SUFFIX_LENGTH);
        assert!(suffix.chars().all(|c| GENERATED_ID_ALPHABET.contains(c)));
    }
}
