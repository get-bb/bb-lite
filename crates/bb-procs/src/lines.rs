/// Splits streamed output into lines the way the domain's terminal output line reader does: a
/// `\r` not followed by `\n` discards the line so far, and blank lines are dropped.
#[derive(Default)]
pub struct LineReader {
    current: String,
    pending_carriage_return: bool,
}

impl LineReader {
    fn complete(&mut self, lines: &mut Vec<String>) {
        let line = std::mem::take(&mut self.current);
        if !line.trim().is_empty() {
            lines.push(line);
        }
    }

    pub fn flush(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        self.pending_carriage_return = false;
        self.complete(&mut lines);
        lines
    }

    pub fn push(&mut self, text: &str) -> Vec<String> {
        let mut lines = Vec::new();
        for character in text.chars() {
            if self.pending_carriage_return {
                self.pending_carriage_return = false;
                if character == '\n' {
                    self.complete(&mut lines);
                    continue;
                }
                self.current.clear();
            }
            match character {
                '\r' => self.pending_carriage_return = true,
                '\n' => self.complete(&mut lines),
                _ => self.current.push(character),
            }
        }
        lines
    }
}

/// Decodes UTF-8 across chunk boundaries, holding back an incomplete trailing sequence.
#[derive(Default)]
pub struct Utf8Decoder {
    held: Vec<u8>,
}

impl Utf8Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.held.extend_from_slice(bytes);
        let keep = match std::str::from_utf8(&self.held) {
            Ok(_) => 0,
            Err(error) if error.error_len().is_none() => self.held.len() - error.valid_up_to(),
            Err(_) => incomplete_tail(&self.held),
        };
        let rest = self.held.split_off(self.held.len() - keep);
        let text = String::from_utf8_lossy(&self.held).into_owned();
        self.held = rest;
        text
    }

    pub fn finish(&mut self) -> String {
        String::from_utf8_lossy(&std::mem::take(&mut self.held)).into_owned()
    }
}

fn incomplete_tail(bytes: &[u8]) -> usize {
    let start = bytes.len().saturating_sub(3);
    for at in (start..bytes.len()).rev() {
        let byte = bytes[at];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let width = match byte {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return 0,
        };
        return if bytes.len() - at < width { bytes.len() - at } else { 0 };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_reader_matches_domain() {
        let mut reader = LineReader::default();
        assert_eq!(reader.push("a\r\nb\rc\n\n  \nd"), ["a", "c"]);
        assert_eq!(reader.flush(), ["d"]);
    }

    #[test]
    fn decoder_holds_split_characters() {
        let mut decoder = Utf8Decoder::default();
        let bytes = "é!".as_bytes();
        assert_eq!(decoder.push(&bytes[..1]), "");
        assert_eq!(decoder.push(&bytes[1..]), "é!");
        assert_eq!(decoder.push(&[0xFF, b'a', 0xE2, 0x82]), "\u{FFFD}a");
        assert_eq!(decoder.finish(), "\u{FFFD}");
    }
}
