//! JSON-lines logging, one object per line on stdout, as the TypeScript server writes.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
    Silent,
}

impl LogLevel {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "debug" => Some(Self::Debug),
            "info" => Some(Self::Info),
            "warn" => Some(Self::Warn),
            "error" => Some(Self::Error),
            "silent" => Some(Self::Silent),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Silent => "silent",
        }
    }
}

type Write = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct Logger {
    minimum: LogLevel,
    write: Write,
}

/// `2026-10-07T01:02:03.456Z`, like JavaScript's `toISOString`.
pub fn iso_timestamp(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000);
    let ms_of_day = epoch_ms.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (hour, minute) = (ms_of_day / 3_600_000, ms_of_day / 60_000 % 60);
    let (second, milli) = (ms_of_day / 1_000 % 60, ms_of_day % 1_000);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

impl Logger {
    pub fn new(minimum: LogLevel) -> Self {
        Self { minimum, write: Arc::new(|line| println!("{line}")) }
    }

    pub fn with_writer(minimum: LogLevel, write: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self { minimum, write: Arc::new(write) }
    }

    pub fn silent() -> Self {
        Self::with_writer(LogLevel::Silent, |_| {})
    }

    fn log(&self, level: LogLevel, message: &str, fields: Value) {
        if level < self.minimum || self.minimum == LogLevel::Silent {
            return;
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        let mut entry = Map::new();
        entry.insert("time".to_owned(), Value::String(iso_timestamp(now.as_millis() as i64)));
        entry.insert("level".to_owned(), Value::String(level.as_str().to_owned()));
        entry.insert("message".to_owned(), Value::String(message.to_owned()));
        if let Value::Object(fields) = fields {
            entry.extend(fields);
        }
        (self.write)(&Value::Object(entry).to_string());
    }

    /// `fields` is a JSON object merged into the line (`json!({"hostId": id})`), or `Value::Null`.
    pub fn debug(&self, message: &str, fields: Value) {
        self.log(LogLevel::Debug, message, fields);
    }

    pub fn info(&self, message: &str, fields: Value) {
        self.log(LogLevel::Info, message, fields);
    }

    pub fn warn(&self, message: &str, fields: Value) {
        self.log(LogLevel::Warn, message, fields);
    }

    pub fn error(&self, message: &str, fields: Value) {
        self.log(LogLevel::Error, message, fields);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use serde_json::json;

    #[test]
    fn writes_json_lines_at_or_above_the_minimum() {
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        let log =
            Logger::with_writer(LogLevel::Warn, move |line| sink.lock().push(line.to_owned()));
        log.info("skipped", Value::Null);
        log.error("Request failed", json!({"path": "/x"}));
        let written = lines.lock();
        assert_eq!(written.len(), 1);
        let entry: Value = serde_json::from_str(&written[0]).unwrap();
        assert_eq!(entry["level"], "error");
        assert_eq!(entry["message"], "Request failed");
        assert_eq!(entry["path"], "/x");
    }

    #[test]
    fn iso_timestamps_match_javascript() {
        assert_eq!(iso_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_timestamp(1_791_334_523_653), "2026-10-07T00:55:23.653Z");
        assert_eq!(iso_timestamp(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
