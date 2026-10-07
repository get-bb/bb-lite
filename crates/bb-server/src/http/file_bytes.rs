//! Answering a workspace file's bytes: content type, a single `Range`, conditional requests.

#![allow(clippy::result_large_err)]

use std::sync::LazyLock;
use std::time::{Duration, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::response::Response;
use bb_core::{RunnerError, RunnerErrorCode};
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use regex::Regex;

use crate::error::ApiError;
use crate::http::range::{ByteSelection, matches_entity_tag, select_range};

/// A file as the runner read it.
#[derive(Clone, Debug, PartialEq)]
pub struct FileBytes {
    pub content: Bytes,
    pub mime_type: Option<String>,
    pub size_bytes: u64,
    pub modified_at_ms: Option<f64>,
    /// The content revision (sha) the entity tag is made from.
    pub revision: String,
}

static REVISION_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:HEAD|[0-9a-f]{4,40})$").expect("valid pattern"));

pub fn file_changed() -> ApiError {
    ApiError::new(409, "file_changed", "File changed during read; retry the request")
        .retryable(true)
}

/// The API error a runner failure reading a file answers with.
pub fn file_error(error: RunnerError) -> ApiError {
    let status = match error.code {
        RunnerErrorCode::Conflict => return file_changed(),
        RunnerErrorCode::InvalidPath => 400,
        RunnerErrorCode::PermissionDenied => 403,
        RunnerErrorCode::FileTooLarge => 413,
        _ => return ApiError::from(error),
    };
    ApiError::new(status, error.code.as_str(), error.message).retryable(false)
}

pub fn relative_file_segments(raw_path: &str) -> Result<Vec<String>, ApiError> {
    let normalized = raw_path.replace('\\', "/");
    let segments: Vec<String> = normalized.split('/').map(str::to_owned).collect();
    let unsafe_segment = segments.iter().any(|segment| ["", ".", ".."].contains(&segment.as_str()));
    if unsafe_segment || raw_path.contains('\0') {
        return Err(ApiError::new(400, "invalid_path", "Invalid file path").retryable(false));
    }
    Ok(segments)
}

pub fn revision_ref(reference: &str) -> Result<&str, ApiError> {
    if REVISION_REF.is_match(reference) {
        Ok(reference)
    } else {
        Err(ApiError::new(400, "invalid_ref", "Invalid revision"))
    }
}

fn http_date(ms: f64) -> Option<String> {
    let millis = u64::try_from(ms.floor() as i64).ok()?;
    Some(httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_millis(millis)))
}

fn insert(headers: &mut HeaderMap, name: header::HeaderName, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(name, value);
    }
}

pub fn raw_file_headers(file: &FileBytes) -> HeaderMap {
    let mime_type = file.mime_type.as_deref().unwrap_or("application/octet-stream");
    let essence = mime_type.split(';').next().unwrap_or("").trim().to_lowercase();
    let html = essence == "text/html";
    let mut headers = HeaderMap::new();
    insert(&mut headers, header::ACCEPT_RANGES, "bytes");
    insert(
        &mut headers,
        header::CACHE_CONTROL,
        if html { "no-store" } else { "private, no-cache" },
    );
    insert(&mut headers, header::CONTENT_SECURITY_POLICY, "sandbox allow-scripts");
    insert(
        &mut headers,
        header::CONTENT_TYPE,
        if html { "text/html; charset=utf-8" } else { mime_type },
    );
    insert(&mut headers, header::ETAG, &format!("W/\"file-{}\"", file.revision));
    insert(&mut headers, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    if let Some(date) = file.modified_at_ms.and_then(http_date) {
        insert(&mut headers, header::LAST_MODIFIED, &date);
    }
    headers
}

fn respond(status: u16, headers: HeaderMap, body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    *response.headers_mut() = headers;
    response
}

/// The response to `method` with `request` headers for `file`: 304 on a matching
/// `If-None-Match` (unless HTML, which is never revalidated), 206 or 416 for a `Range` on a
/// `GET` without `If-Range`, the bytes otherwise.
pub fn serve_file_bytes(
    method: &Method,
    request: &HeaderMap,
    file: &FileBytes,
) -> Result<Response, ApiError> {
    let size = i64::try_from(file.size_bytes).unwrap_or(i64::MAX);
    let mut headers = raw_file_headers(file);
    let revalidates =
        headers.get(header::CACHE_CONTROL).is_none_or(|value| value.as_bytes() != b"no-store");
    let etag =
        headers.get(header::ETAG).and_then(|value| value.to_str().ok()).unwrap_or("").to_owned();
    let request_header = |name: header::HeaderName| {
        let values: Vec<&str> =
            request.get_all(name).iter().filter_map(|value| value.to_str().ok()).collect();
        (!values.is_empty()).then(|| values.join(", "))
    };
    if revalidates && matches_entity_tag(request_header(header::IF_NONE_MATCH).as_deref(), &etag) {
        return Ok(respond(304, headers, Body::empty()));
    }
    let ranged = method == Method::GET && !request.contains_key(header::IF_RANGE);
    let wanted = request_header(header::RANGE).filter(|_| ranged);
    let Some(ByteSelection { start, end, status }) =
        select_range(&mut headers, wanted.as_deref(), size)
    else {
        insert(&mut headers, header::CONTENT_LENGTH, "0");
        return Ok(respond(416, headers, Body::empty()));
    };
    if method == Method::HEAD || size == 0 {
        return Ok(respond(status, headers, Body::empty()));
    }
    let (Ok(from), Ok(to)) = (usize::try_from(start), usize::try_from(end)) else {
        return Err(file_changed());
    };
    if to >= file.content.len() {
        return Err(file_changed());
    }
    Ok(respond(status, headers, Body::from(file.content.slice(from..=to))))
}
