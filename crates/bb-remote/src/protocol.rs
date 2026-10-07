use std::fmt::Write as _;

use bb_core::{Lane, RunnerError, RunnerErrorCode, RunnerEvent};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;

pub use bb_core::api::{LEASE_MS, PING_INTERVAL_MS, is_runner_method, request_timeout_ms};

pub const MAX_FRAME_BYTES: usize = 768 * 1024;
pub const REPLACED_CLOSE_CODE: u16 = 4001;
const PART_CHARS: usize = 256 * 1024;
const MAX_ASSEMBLED_CHARS: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub instance_id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_acked_seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WireError {
    #[serde(deserialize_with = "lenient_code")]
    pub code: RunnerErrorCode,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

fn lenient_code<'de, D: Deserializer<'de>>(deserializer: D) -> Result<RunnerErrorCode, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(value.as_str().map_or(RunnerErrorCode::Failed, RunnerErrorCode::parse))
}

/// A whole frame; `part` frames exist only on the wire (see `encode_frame`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Frame {
    Hello(Hello),
    #[serde(rename_all = "camelCase")]
    Welcome {
        last_seq: u64,
    },
    Req {
        id: u64,
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<Value>,
    },
    Res {
        id: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<WireError>,
    },
    Evt {
        event: RunnerEvent,
    },
    Ack {
        seq: u64,
    },
    Ping,
    Pong,
}

/// Serializes a frame; above `MAX_FRAME_BYTES` it becomes `part` frames of at
/// most 256 Ki UTF-16 code units each, split exactly where JavaScript would.
pub fn encode_frame(frame: &Frame) -> Vec<String> {
    let text = match serde_json::to_string(frame) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    if text.len() <= MAX_FRAME_BYTES {
        return vec![text];
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let count = units.chunks(PART_CHARS).len();
    units
        .chunks(PART_CHARS)
        .enumerate()
        .map(|(index, data)| {
            let mut part = String::with_capacity(data.len() + 32);
            part.push_str(r#"{"t":"part","data":"#);
            write_js_string(&mut part, data);
            part.push_str(if index + 1 == count {
                r#","last":true}"#
            } else {
                r#","last":false}"#
            });
            part
        })
        .collect()
}

fn write_js_string(out: &mut String, units: &[u16]) {
    out.push('"');
    for item in char::decode_utf16(units.iter().copied()) {
        match item {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            Ok(c) => out.push(c),
            Err(lone) => {
                let _ = write!(out, "\\u{:04x}", lone.unpaired_surrogate());
            }
        }
    }
    out.push('"');
}

fn unescape_js_string(raw: &str) -> Option<Vec<u16>> {
    let inner = raw.strip_prefix('"')?.strip_suffix('"')?;
    let mut units = Vec::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            let mut buffer = [0u16; 2];
            units.extend_from_slice(c.encode_utf16(&mut buffer));
            continue;
        }
        let unit = match chars.next()? {
            '"' => 0x22,
            '\\' => 0x5c,
            '/' => 0x2f,
            'b' => 0x08,
            'f' => 0x0c,
            'n' => 0x0a,
            'r' => 0x0d,
            't' => 0x09,
            'u' => {
                let hex: String = chars.by_ref().take(4).collect();
                u16::from_str_radix(&hex, 16).ok()?
            }
            _ => return None,
        };
        units.push(unit);
    }
    Some(units)
}

#[derive(Deserialize)]
struct RawPart<'a> {
    t: &'a str,
    #[serde(borrow)]
    data: &'a RawValue,
    last: bool,
}

fn parse_frame(text: &str) -> Option<Frame> {
    let frame: Frame = serde_json::from_str(text).ok()?;
    if let Frame::Evt { event } = &frame
        && event.lane == Lane::Reliable
        && event.seq.is_none()
    {
        return None;
    }
    Some(frame)
}

/// Turns received text frames back into whole frames, reassembling `part`
/// frames. Returns `None` for anything malformed or still incomplete.
#[derive(Default)]
pub struct FrameDecoder {
    assembling: Vec<u16>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decode(&mut self, text: &str) -> Option<Frame> {
        let part = match serde_json::from_str::<RawPart>(text) {
            Ok(part) if part.t == "part" => part,
            _ => return parse_frame(text),
        };
        let data = unescape_js_string(part.data.get())?;
        self.assembling.extend_from_slice(&data);
        let whole = if part.last {
            String::from_utf16(&self.assembling).ok().and_then(|text| parse_frame(&text))
        } else {
            None
        };
        if part.last || self.assembling.len() > MAX_ASSEMBLED_CHARS {
            self.assembling = Vec::new();
        }
        whole
    }
}

pub fn to_wire_error(error: &RunnerError) -> WireError {
    WireError { code: error.code, message: error.message.clone(), retryable: error.retryable }
}

pub fn from_wire_error(error: Option<WireError>) -> RunnerError {
    match error {
        None => RunnerError::failed("Runner failed"),
        Some(error) => {
            RunnerError { code: error.code, message: error.message, retryable: error.retryable }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn small_frames_are_single_json_texts() {
        let frame = Frame::Req { id: 3, method: "describe".into(), params: Some(json!({})) };
        let parts = encode_frame(&frame);
        assert_eq!(parts, [r#"{"t":"req","id":3,"method":"describe","params":{}}"#]);
        assert_eq!(FrameDecoder::new().decode(&parts[0]), Some(frame));
        let error =
            json!({"t": "res", "id": 1, "ok": false, "error": {"code": "weird", "message": "m"}});
        let Some(Frame::Res { error: Some(error), .. }) =
            FrameDecoder::new().decode(&error.to_string())
        else {
            panic!("expected a res frame");
        };
        assert_eq!((error.code, error.retryable), (RunnerErrorCode::Failed, false));
        let unsequenced = concat!(
            r#"{"t":"evt","event":{"lane":"reliable","kind":"script.output","#,
            r#""operationId":"o","text":""}}"#
        );
        assert_eq!(FrameDecoder::new().decode(unsequenced), None);
        assert_eq!(FrameDecoder::new().decode(r#"{"t":"nope"}"#), None);
    }

    #[test]
    fn large_non_ascii_frames_split_on_utf16_units_and_reassemble() {
        let title = format!("a{}", "\u{1F600}\u{20ac}\n".repeat(200_000));
        let frame = Frame::Req {
            id: 1,
            method: "renameSession".into(),
            params: Some(json!({"threadId": "thr_1", "title": title})),
        };
        let whole = serde_json::to_string(&frame).unwrap();
        let parts = encode_frame(&frame);
        let units = whole.encode_utf16().count();
        assert_eq!(parts.len(), units.div_ceil(PART_CHARS));
        assert!(parts.iter().all(|part| part.len() <= MAX_FRAME_BYTES));
        assert!(parts.iter().any(|part| part.contains("\\ud83d\"") || part.contains("\"\\ude00")));
        let mut decoder = FrameDecoder::new();
        let decoded: Vec<_> = parts.iter().map(|part| decoder.decode(part)).collect();
        assert!(decoded[..parts.len() - 1].iter().all(Option::is_none));
        assert_eq!(decoded.last().cloned().flatten(), Some(frame));
        let first: Value = serde_json::from_str(&parts[0]).unwrap_or(Value::Null);
        assert!(first.is_null() || first["last"] == json!(false));
    }
}
