//! Response compression: JSON answers of 1 KB or more, and static assets compressed once and
//! kept by content.

#![allow(clippy::result_large_err)]

use std::io::Write;
use std::sync::{Arc, LazyLock};

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use base64::Engine;
use http::{HeaderMap, HeaderValue, header};
use indexmap::IndexMap;
use parking_lot::Mutex;
use regex::Regex;
use sha2::{Digest, Sha256};

use crate::error::ApiError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Encoding {
    Br,
    Gzip,
}

impl Encoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Encoding::Br => "br",
            Encoding::Gzip => "gzip",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Effort {
    Fast,
    Small,
}

impl Effort {
    fn as_str(self) -> &'static str {
        match self {
            Effort::Fast => "fast",
            Effort::Small => "small",
        }
    }

    fn level(self, encoding: Encoding) -> u32 {
        match (self, encoding) {
            (Effort::Fast, Encoding::Br) => 4,
            (Effort::Fast, Encoding::Gzip) => 6,
            (Effort::Small, _) => 9,
        }
    }
}

/// A response extension that keeps `compress_json` from touching a JSON answer (plugin HTTP
/// routes, streams).
#[derive(Clone, Copy, Debug, Default)]
pub struct Uncompressed;

pub const MIN_BYTES: usize = 1024;
const MEMO_MIN_BYTES: usize = 64 * 1024;
const MEMO_LIMIT: usize = 256;
const JSON_TYPE: &str = "application/json";

static COMPRESSIBLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^text/|[/+](?:json|javascript|xml)(?-u:\b)|/wasm$").expect("valid pattern")
});
static UNCOMPRESSED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/events/wait$").expect("valid pattern"));
static BR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)br(?-u:\b)").expect("valid pattern"));
static GZIP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)gzip(?-u:\b)").expect("valid pattern"));
static MEMO: LazyLock<Mutex<IndexMap<String, Arc<Vec<u8>>>>> =
    LazyLock::new(|| Mutex::new(IndexMap::new()));

/// The encoding to answer with for an `Accept-Encoding` header: brotli, else gzip.
pub fn accepted(header: Option<&str>) -> Option<Encoding> {
    let header = header?;
    if BR.is_match(header) {
        return Some(Encoding::Br);
    }
    GZIP.is_match(header).then_some(Encoding::Gzip)
}

pub fn compress(data: &[u8], encoding: Encoding, effort: Effort) -> std::io::Result<Vec<u8>> {
    let level = effort.level(encoding);
    match encoding {
        Encoding::Gzip => {
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(level));
            encoder.write_all(data)?;
            encoder.finish()
        }
        Encoding::Br => {
            let params = brotli::enc::BrotliEncoderParams {
                quality: i32::try_from(level).unwrap_or(11),
                size_hint: data.len(),
                ..Default::default()
            };
            let mut packed = Vec::new();
            brotli::BrotliCompress(&mut &data[..], &mut packed, &params)?;
            Ok(packed)
        }
    }
}

fn remember_recent(key: String, value: Arc<Vec<u8>>) -> Arc<Vec<u8>> {
    let mut memo = MEMO.lock();
    memo.shift_remove(&key);
    memo.insert(key, value.clone());
    while memo.len() > MEMO_LIMIT {
        memo.shift_remove_index(0);
    }
    value
}

pub fn compress_once(
    data: &[u8],
    encoding: Encoding,
    effort: Effort,
) -> std::io::Result<Arc<Vec<u8>>> {
    let digest = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(data));
    let key = format!("{}:{}:{digest}", effort.as_str(), encoding.as_str());
    let known = MEMO.lock().get(&key).cloned();
    let value = match known {
        Some(value) => value,
        None => Arc::new(compress(data, encoding, effort)?),
    };
    Ok(remember_recent(key, value))
}

async fn compress_blocking(
    data: Bytes,
    encoding: Encoding,
    effort: Effort,
    memoize: bool,
) -> Result<Bytes, ApiError> {
    let packed = tokio::task::spawn_blocking(move || {
        if memoize {
            compress_once(&data, encoding, effort).map(|packed| packed.as_ref().clone())
        } else {
            compress(&data, encoding, effort)
        }
    })
    .await
    .map_err(ApiError::internal)??;
    Ok(Bytes::from(packed))
}

/// A static asset's body for `accept_encoding`; sets `vary` (and `content-encoding` when it
/// compresses) on `headers`, whose `content-type` decides whether it is compressible.
pub async fn encode_static(
    content: Bytes,
    headers: &mut HeaderMap,
    accept_encoding: Option<&str>,
) -> Result<Bytes, ApiError> {
    let kind = headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok());
    let fits = content.len() >= MIN_BYTES && COMPRESSIBLE.is_match(kind.unwrap_or(""));
    if fits {
        headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    let Some(encoding) = accepted(accept_encoding).filter(|_| fits) else {
        return Ok(content);
    };
    headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding.as_str()));
    compress_blocking(content, encoding, Effort::Small, true).await
}

fn is_json(headers: &HeaderMap) -> bool {
    let kind = headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok());
    kind.and_then(|kind| kind.split(';').next())
        .is_some_and(|kind| kind.trim().eq_ignore_ascii_case(JSON_TYPE))
}

/// Middleware (`axum::middleware::from_fn(compress_json)`) that compresses JSON answers of
/// `MIN_BYTES` or more for a client that accepts brotli or gzip, except the event long-poll
/// and answers marked `Uncompressed`.
pub async fn compress_json(request: Request, next: Next) -> Response {
    let accept = request.headers().get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok());
    let encoding = accepted(accept);
    let Some(encoding) = encoding.filter(|_| !UNCOMPRESSED.is_match(request.uri().path())) else {
        return next.run(request).await;
    };
    let response = next.run(request).await;
    let eligible = is_json(response.headers())
        && !response.headers().contains_key(header::CONTENT_ENCODING)
        && response.extensions().get::<Uncompressed>().is_none();
    if !eligible {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let body = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(body) => body,
        Err(error) => {
            return axum::response::IntoResponse::into_response(ApiError::internal(error));
        }
    };
    if body.len() < MIN_BYTES {
        return Response::from_parts(parts, Body::from(body));
    }
    let memoize = body.len() >= MEMO_MIN_BYTES;
    let packed = match compress_blocking(body, encoding, Effort::Fast, memoize).await {
        Ok(packed) => packed,
        Err(error) => return axum::response::IntoResponse::into_response(error),
    };
    let headers = &mut parts.headers;
    headers.remove(header::CONTENT_LENGTH);
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(JSON_TYPE));
    headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding.as_str()));
    headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    Response::from_parts(parts, Body::from(packed))
}
