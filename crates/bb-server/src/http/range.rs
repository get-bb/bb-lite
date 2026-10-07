//! A single `Range` request header, entity-tag matching and ranged file answers.

use std::io::SeekFrom;
use std::path::Path;
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::response::Response;
use http::{HeaderMap, HeaderValue, StatusCode, header};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteRange {
    pub start: i64,
    pub end: i64,
}

/// The bytes to send: `end` is inclusive and is `start - 1` for an empty body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteSelection {
    pub start: i64,
    pub end: i64,
    pub status: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParsedRange {
    Whole,
    Unsatisfiable,
    Bytes(ByteRange),
}

fn saturating_number(digits: &str) -> i64 {
    digits
        .bytes()
        .fold(0i64, |total, digit| total.saturating_mul(10).saturating_add(i64::from(digit - b'0')))
}

pub fn parse_single_range(header: Option<&str>, size: i64) -> ParsedRange {
    let Some(spec) = header.unwrap_or("").trim().strip_prefix("bytes=") else {
        return ParsedRange::Whole;
    };
    let Some((first, last)) = spec.split_once('-') else {
        return ParsedRange::Whole;
    };
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(first) || !digits(last) || (first.is_empty() && last.is_empty()) {
        return ParsedRange::Whole;
    }
    if first.is_empty() {
        let length = saturating_number(last).min(size);
        return if length == 0 {
            ParsedRange::Unsatisfiable
        } else {
            ParsedRange::Bytes(ByteRange { start: size - length, end: size - 1 })
        };
    }
    let start = saturating_number(first);
    let end = if last.is_empty() { size - 1 } else { saturating_number(last).min(size - 1) };
    if start >= size || end < start {
        ParsedRange::Unsatisfiable
    } else {
        ParsedRange::Bytes(ByteRange { start, end })
    }
}

pub fn matches_entity_tag(header: Option<&str>, etag: &str) -> bool {
    fn opaque(tag: &str) -> &str {
        let tag = tag.trim();
        tag.strip_prefix("W/").unwrap_or(tag)
    }
    let Some(header) = header else {
        return false;
    };
    header.split(',').map(opaque).any(|tag| tag == "*" || tag == opaque(etag))
}

fn set(headers: &mut HeaderMap, name: header::HeaderName, value: String) {
    if let Ok(value) = HeaderValue::from_str(&value) {
        headers.insert(name, value);
    }
}

/// Sets `content-length` and `content-range` for the range asked for; `None` means 416.
pub fn select_range(
    headers: &mut HeaderMap,
    header: Option<&str>,
    size: i64,
) -> Option<ByteSelection> {
    let range = parse_single_range(header, size);
    let (start, end) = match range {
        ParsedRange::Unsatisfiable => {
            set(headers, header::CONTENT_RANGE, format!("bytes */{size}"));
            return None;
        }
        ParsedRange::Whole => (0, size - 1),
        ParsedRange::Bytes(ByteRange { start, end }) => (start, end),
    };
    set(headers, header::CONTENT_LENGTH, (end - start + 1).to_string());
    if range == ParsedRange::Whole {
        return Some(ByteSelection { start, end, status: 200 });
    }
    set(headers, header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    Some(ByteSelection { start, end, status: 206 })
}

pub struct FileResponseOptions<'a> {
    pub range: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
    pub content_type: &'a str,
    pub cache_control: &'a str,
}

fn respond(status: u16, headers: HeaderMap, body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    *response.headers_mut() = headers;
    response
}

/// A file on disk with a size-and-mtime entity tag and `Range` support; `None` when the
/// path is not a readable file.
pub async fn file_response(path: &Path, options: FileResponseOptions<'_>) -> Option<Response> {
    let file = tokio::fs::metadata(path).await.ok().filter(|meta| meta.is_file())?;
    let size = i64::try_from(file.len()).unwrap_or(i64::MAX);
    let modified_ms = file
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_millis());
    let etag = format!("\"{size:x}-{modified_ms:x}\"");
    let mut headers = HeaderMap::new();
    set(&mut headers, header::ACCEPT_RANGES, "bytes".to_owned());
    set(&mut headers, header::CACHE_CONTROL, options.cache_control.to_owned());
    set(&mut headers, header::CONTENT_TYPE, options.content_type.to_owned());
    set(&mut headers, header::ETAG, etag.clone());
    if options.if_none_match.is_some_and(|tags| tags.split(',').any(|tag| tag.trim() == etag)) {
        return Some(respond(304, headers, Body::empty()));
    }
    let Some(ByteSelection { start, end, status }) =
        select_range(&mut headers, options.range, size)
    else {
        return Some(respond(416, headers, Body::empty()));
    };
    if size == 0 {
        return Some(respond(status, headers, Body::empty()));
    }
    let mut handle = tokio::fs::File::open(path).await.ok()?;
    handle.seek(SeekFrom::Start(u64::try_from(start).unwrap_or(0))).await.ok()?;
    let length = u64::try_from(end - start + 1).unwrap_or(0);
    let body = Body::from_stream(ReaderStream::new(handle.take(length)));
    Some(respond(status, headers, body))
}
