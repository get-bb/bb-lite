use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

pub const TUNNEL_PROTOCOL_QUERY_PARAM: &str = "v";

pub const HEARTBEAT_REQUEST: &str = "bbt:hb";
pub const HEARTBEAT_RESPONSE: &str = "bbt:hb-ack";
pub const TUNNEL_REPLACED_CLOSE_REASON: &str = "replaced by a new tunnel connection";

pub const MAX_CHUNK_BYTES: usize = 1024 * 1024;

const OPEN_HTTP: u8 = 1;
const BODY_CHUNK: u8 = 2;
const BODY_END: u8 = 3;
const RESP_HEAD: u8 = 4;
const OPEN_WS: u8 = 5;
const WS_OPEN_ACK: u8 = 6;
const WS_DATA: u8 = 7;
const CLOSE_STREAM: u8 = 8;

/// A header as `[name, value]`, serialized as a two-element JSON array.
pub type HeaderPair = (String, String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenHttpFrame {
    pub stream_id: u32,
    pub method: String,
    pub path: String,
    pub headers: Vec<HeaderPair>,
    pub has_body: bool,
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenWsFrame {
    pub stream_id: u32,
    pub path: String,
    pub headers: Vec<HeaderPair>,
    pub protocols: Vec<String>,
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    OpenHttp(OpenHttpFrame),
    BodyChunk { stream_id: u32, data: Vec<u8> },
    BodyEnd { stream_id: u32 },
    RespHead { stream_id: u32, status: u16, headers: Vec<HeaderPair> },
    OpenWs(OpenWsFrame),
    WsOpenAck { stream_id: u32, protocol: Option<String> },
    WsData { stream_id: u32, is_binary: bool, data: Vec<u8> },
    CloseStream { stream_id: u32, code: u16, reason: String },
}

impl Frame {
    pub fn stream_id(&self) -> u32 {
        match self {
            Frame::OpenHttp(f) => f.stream_id,
            Frame::OpenWs(f) => f.stream_id,
            Frame::BodyChunk { stream_id, .. }
            | Frame::BodyEnd { stream_id }
            | Frame::RespHead { stream_id, .. }
            | Frame::WsOpenAck { stream_id, .. }
            | Frame::WsData { stream_id, .. }
            | Frame::CloseStream { stream_id, .. } => *stream_id,
        }
    }
}

/// An encode or decode failure; the message matches the TypeScript `Error` message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractError(pub String);

impl std::fmt::Display for ContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ContractError {}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenHttpMeta {
    method: String,
    path: String,
    headers: Vec<HeaderPair>,
    has_body: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
struct RespHeadMeta {
    status: u16,
    headers: Vec<HeaderPair>,
}

#[derive(Serialize, Deserialize)]
struct OpenWsMeta {
    path: String,
    headers: Vec<HeaderPair>,
    protocols: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
struct WsOpenAckMeta {
    protocol: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct CloseStreamMeta {
    code: u16,
    reason: String,
}

fn with_header(kind: u8, stream_id: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind);
    out.extend_from_slice(&stream_id.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn json_payload<T: Serialize>(value: &T) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

fn string_target(target: Option<serde_json::Value>) -> Option<String> {
    match target {
        Some(serde_json::Value::String(s)) => Some(s),
        _ => None,
    }
}

pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, ContractError> {
    Ok(match frame {
        Frame::OpenHttp(f) => {
            let meta = OpenHttpMeta {
                method: f.method.clone(),
                path: f.path.clone(),
                headers: f.headers.clone(),
                has_body: f.has_body,
                target: f.target.clone().map(serde_json::Value::String),
            };
            with_header(OPEN_HTTP, f.stream_id, &json_payload(&meta))
        }
        Frame::BodyChunk { stream_id, data } => {
            if data.len() > MAX_CHUNK_BYTES {
                return Err(ContractError(format!(
                    "tunnel-contract: body chunk of {} bytes exceeds MAX_CHUNK_BYTES",
                    data.len()
                )));
            }
            with_header(BODY_CHUNK, *stream_id, data)
        }
        Frame::BodyEnd { stream_id } => with_header(BODY_END, *stream_id, &[]),
        Frame::RespHead { stream_id, status, headers } => {
            let meta = RespHeadMeta { status: *status, headers: headers.clone() };
            with_header(RESP_HEAD, *stream_id, &json_payload(&meta))
        }
        Frame::OpenWs(f) => {
            let meta = OpenWsMeta {
                path: f.path.clone(),
                headers: f.headers.clone(),
                protocols: f.protocols.clone(),
                target: f.target.clone().map(serde_json::Value::String),
            };
            with_header(OPEN_WS, f.stream_id, &json_payload(&meta))
        }
        Frame::WsOpenAck { stream_id, protocol } => {
            let meta = WsOpenAckMeta { protocol: protocol.clone() };
            with_header(WS_OPEN_ACK, *stream_id, &json_payload(&meta))
        }
        Frame::WsData { stream_id, is_binary, data } => {
            let mut payload = Vec::with_capacity(1 + data.len());
            payload.push(u8::from(*is_binary));
            payload.extend_from_slice(data);
            with_header(WS_DATA, *stream_id, &payload)
        }
        Frame::CloseStream { stream_id, code, reason } => {
            let meta = CloseStreamMeta { code: *code, reason: reason.clone() };
            with_header(CLOSE_STREAM, *stream_id, &json_payload(&meta))
        }
    })
}

fn parse_json<T: for<'de> Deserialize<'de>>(
    payload: &[u8],
    what: &str,
) -> Result<T, ContractError> {
    let text = String::from_utf8_lossy(payload);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text)
        .map_err(|_| ContractError(format!("tunnel-contract: malformed {what} frame payload")))
}

pub fn decode_frame(buf: &[u8]) -> Result<Frame, ContractError> {
    if buf.len() < 5 {
        return Err(ContractError(format!(
            "tunnel-contract: frame too short ({} bytes)",
            buf.len()
        )));
    }
    let kind = buf[0];
    let stream_id = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
    let payload = &buf[5..];
    Ok(match kind {
        OPEN_HTTP => {
            let meta: OpenHttpMeta = parse_json(payload, "open-http")?;
            Frame::OpenHttp(OpenHttpFrame {
                stream_id,
                method: meta.method,
                path: meta.path,
                headers: meta.headers,
                has_body: meta.has_body,
                target: string_target(meta.target),
            })
        }
        BODY_CHUNK => Frame::BodyChunk { stream_id, data: payload.to_vec() },
        BODY_END => Frame::BodyEnd { stream_id },
        RESP_HEAD => {
            let meta: RespHeadMeta = parse_json(payload, "resp-head")?;
            Frame::RespHead { stream_id, status: meta.status, headers: meta.headers }
        }
        OPEN_WS => {
            let meta: OpenWsMeta = parse_json(payload, "open-ws")?;
            Frame::OpenWs(OpenWsFrame {
                stream_id,
                path: meta.path,
                headers: meta.headers,
                protocols: meta.protocols,
                target: string_target(meta.target),
            })
        }
        WS_OPEN_ACK => {
            let meta: WsOpenAckMeta = parse_json(payload, "ws-open-ack")?;
            Frame::WsOpenAck { stream_id, protocol: meta.protocol }
        }
        WS_DATA => {
            let Some((&flag, data)) = payload.split_first() else {
                return Err(ContractError(
                    "tunnel-contract: ws-data frame missing binary flag".to_owned(),
                ));
            };
            Frame::WsData { stream_id, is_binary: flag == 1, data: data.to_vec() }
        }
        CLOSE_STREAM => {
            let meta: CloseStreamMeta = parse_json(payload, "close-stream")?;
            Frame::CloseStream { stream_id, code: meta.code, reason: meta.reason }
        }
        other => {
            return Err(ContractError(format!("tunnel-contract: unknown frame type {other}")));
        }
    })
}

/// Splits `data` into `body-chunk` frames of at most [`MAX_CHUNK_BYTES`]; empty data yields none.
pub fn chunk_body(stream_id: u32, data: &[u8]) -> impl Iterator<Item = Frame> + '_ {
    data.chunks(MAX_CHUNK_BYTES)
        .map(move |part| Frame::BodyChunk { stream_id, data: part.to_vec() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(name: &str, value: &str) -> HeaderPair {
        (name.to_owned(), value.to_owned())
    }

    fn data() -> Vec<u8> {
        (0..1000).map(|i| (i % 256) as u8).collect()
    }

    fn open_http(stream_id: u32, post: bool, target: Option<&str>) -> Frame {
        Frame::OpenHttp(OpenHttpFrame {
            stream_id,
            method: if post { "POST" } else { "GET" }.to_owned(),
            path: if post { "/a?b=1" } else { "/" }.to_owned(),
            headers: if post { vec![h("cookie", "a=b; ✓")] } else { vec![] },
            has_body: post,
            target: target.map(str::to_owned),
        })
    }

    fn open_ws(stream_id: u32, target: Option<&str>) -> Frame {
        Frame::OpenWs(OpenWsFrame {
            stream_id,
            path: "/ws".to_owned(),
            headers: vec![h("cookie", "a=b; ✓")],
            protocols: vec!["bb.v1".to_owned()],
            target: target.map(str::to_owned),
        })
    }

    fn frames() -> Vec<Frame> {
        vec![
            open_http(7, true, None),
            open_http(8, false, Some("8000")),
            Frame::BodyChunk { stream_id: 0xffff_ffff, data: data() },
            Frame::BodyEnd { stream_id: 0 },
            Frame::RespHead { stream_id: 12, status: 204, headers: vec![h("cookie", "a=b; ✓")] },
            open_ws(20, None),
            open_ws(21, Some("3000")),
            Frame::WsOpenAck { stream_id: 20, protocol: None },
            Frame::WsData { stream_id: 20, is_binary: true, data: data() },
            Frame::WsData { stream_id: 20, is_binary: false, data: vec![] },
            Frame::CloseStream { stream_id: 20, code: 1008, reason: "not shared".to_owned() },
        ]
    }

    #[test]
    fn round_trips_every_frame_type() {
        for frame in frames() {
            let encoded = encode_frame(&frame).unwrap();
            assert_eq!(decode_frame(&encoded).unwrap(), frame);
            assert_eq!(decode_frame(&encoded.clone()).unwrap().stream_id(), frame.stream_id());
        }
        let ack = Frame::WsOpenAck { stream_id: 3, protocol: Some("bb.v1".to_owned()) };
        assert_eq!(decode_frame(&encode_frame(&ack).unwrap()).unwrap(), ack);
    }

    #[test]
    fn keeps_the_wire_layout() {
        let types: Vec<u8> = frames().iter().map(|f| encode_frame(f).unwrap()[0]).collect();
        assert_eq!(types, vec![1, 1, 2, 3, 4, 5, 5, 6, 7, 7, 8]);
        let end = encode_frame(&Frame::BodyEnd { stream_id: 0x0102_0304 }).unwrap();
        assert_eq!(end, vec![3, 1, 2, 3, 4]);
        let open = encode_frame(&frames()[0]).unwrap();
        assert_eq!(
            std::str::from_utf8(&open[5..]).unwrap(),
            r#"{"method":"POST","path":"/a?b=1","headers":[["cookie","a=b; ✓"]],"hasBody":true}"#
        );
        let oversized = vec![0u8; 2 * MAX_CHUNK_BYTES + 1];
        let sizes: Vec<usize> = chunk_body(1, &oversized)
            .map(|f| match f {
                Frame::BodyChunk { data, .. } => data.len(),
                _ => 0,
            })
            .collect();
        assert_eq!(sizes, vec![MAX_CHUNK_BYTES, MAX_CHUNK_BYTES, 1]);
        assert_eq!(chunk_body(1, &[]).count(), 0);
    }

    #[test]
    fn hand_checked_bytes() {
        let data =
            encode_frame(&Frame::WsData { stream_id: 20, is_binary: false, data: b"hi".to_vec() })
                .unwrap();
        assert_eq!(data, vec![7, 0, 0, 0, 20, 0, b'h', b'i']);

        let close = encode_frame(&Frame::CloseStream {
            stream_id: 0x0100_0002,
            code: 1011,
            reason: "a\"\n".to_owned(),
        })
        .unwrap();
        let mut expected = vec![8, 1, 0, 0, 2];
        expected.extend_from_slice(br#"{"code":1011,"reason":"a\"\n"}"#);
        assert_eq!(close, expected);

        let ack = encode_frame(&Frame::WsOpenAck { stream_id: 1, protocol: None }).unwrap();
        let mut expected = vec![6, 0, 0, 0, 1];
        expected.extend_from_slice(br#"{"protocol":null}"#);
        assert_eq!(ack, expected);

        let ws = encode_frame(&open_ws(21, Some("3000"))).unwrap();
        let mut expected = vec![5, 0, 0, 0, 21];
        expected.extend_from_slice(
            r#"{"path":"/ws","headers":[["cookie","a=b; ✓"]],"protocols":["bb.v1"],"target":"3000"}"#
                .as_bytes(),
        );
        assert_eq!(ws, expected);

        let head =
            encode_frame(&Frame::RespHead { stream_id: 12, status: 204, headers: vec![] }).unwrap();
        let mut expected = vec![4, 0, 0, 0, 12];
        expected.extend_from_slice(br#"{"status":204,"headers":[]}"#);
        assert_eq!(head, expected);

        let chunk = encode_frame(&Frame::BodyChunk { stream_id: 9, data: vec![0xff, 0] }).unwrap();
        assert_eq!(chunk, vec![2, 0, 0, 0, 9, 0xff, 0]);
    }

    #[test]
    fn decode_errors_and_lenient_target() {
        let err = |b: &[u8]| decode_frame(b).unwrap_err().0;
        assert_eq!(err(&[1, 0, 0]), "tunnel-contract: frame too short (3 bytes)");
        assert_eq!(err(&[9, 0, 0, 0, 0]), "tunnel-contract: unknown frame type 9");
        assert_eq!(err(&[7, 0, 0, 0, 0]), "tunnel-contract: ws-data frame missing binary flag");
        assert_eq!(
            err(&[8, 0, 0, 0, 0, b'{']),
            "tunnel-contract: malformed close-stream frame payload"
        );
        let mut open = vec![1, 0, 0, 0, 4];
        open.extend_from_slice(
            br#"{"method":"GET","path":"/","headers":[],"hasBody":false,"target":80}"#,
        );
        assert_eq!(decode_frame(&open).unwrap(), {
            let Frame::OpenHttp(mut f) = open_http(4, false, None) else { unreachable!() };
            f.target = None;
            Frame::OpenHttp(f)
        });
        let too_big = Frame::BodyChunk { stream_id: 1, data: vec![0; MAX_CHUNK_BYTES + 1] };
        assert_eq!(
            encode_frame(&too_big).unwrap_err().0,
            format!(
                "tunnel-contract: body chunk of {} bytes exceeds MAX_CHUNK_BYTES",
                MAX_CHUNK_BYTES + 1
            )
        );
    }
}
