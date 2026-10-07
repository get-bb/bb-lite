//! The built web app: hashed `/assets/` cached forever, an SPA fallback to `index.html`
//! for every other path, compressed when the client accepts it.

#![allow(clippy::result_large_err)]

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, any};
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use sha2::{Digest, Sha256};

use crate::error::{ApiError, not_found};
use crate::http::compression::encode_static;
use crate::http::range::matches_entity_tag;

const INDEX_PATH: &str = "/index.html";
const ASSETS_PREFIX: &str = "/assets/";

fn cache_control(url_path: &str) -> &'static str {
    if url_path.starts_with(ASSETS_PREFIX) {
        return "public, max-age=31536000, immutable";
    }
    if url_path.ends_with(".html") { "no-cache" } else { "public, max-age=86400" }
}

fn content_type(url_path: &str) -> String {
    let extension = Path::new(url_path).extension().and_then(|ext| ext.to_str()).unwrap_or("");
    let Some(kind) = mime_guess::from_ext(extension).first_raw() else {
        return "application/octet-stream".to_owned();
    };
    let textual =
        kind.starts_with("text/") || kind == "application/javascript" || kind == "application/json";
    if textual { format!("{kind}; charset=utf-8") } else { kind.to_owned() }
}

fn decode_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    for (index, &byte) in bytes.iter().enumerate() {
        if byte == b'%' {
            let pair = bytes.get(index + 1..index + 3)?;
            if !pair.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
        }
    }
    let decoded = percent_encoding::percent_decode_str(path).collect::<Vec<u8>>();
    String::from_utf8(decoded).ok()
}

fn join_url_path(root: &Path, url_path: &str) -> PathBuf {
    let mut joined = root.to_path_buf();
    for segment in url_path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                joined.pop();
            }
            segment => joined.push(segment),
        }
    }
    joined
}

async fn read_if_file(path: &Path) -> Option<Bytes> {
    tokio::fs::read(path).await.ok().map(Bytes::from)
}

fn header_str<'a>(headers: &'a HeaderMap, name: &header::HeaderName) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

async fn file_response(
    url_path: &str,
    content: Bytes,
    request: &HeaderMap,
) -> Result<Response, ApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_control(url_path)));
    let kind = HeaderValue::from_str(&content_type(url_path)).map_err(ApiError::internal)?;
    headers.insert(header::CONTENT_TYPE, kind);
    if url_path.ends_with(".html") {
        let digest = hex::encode(Sha256::digest(&content));
        let etag = format!("W/\"{}\"", &digest[..32]);
        headers.insert(header::ETAG, HeaderValue::from_str(&etag).map_err(ApiError::internal)?);
        if matches_entity_tag(header_str(request, &header::IF_NONE_MATCH), &etag) {
            headers.remove(header::CONTENT_TYPE);
            return Ok((StatusCode::NOT_MODIFIED, headers).into_response());
        }
    }
    let accept_encoding = header_str(request, &header::ACCEPT_ENCODING);
    let body = encode_static(content, &mut headers, accept_encoding).await?;
    Ok((headers, Body::from(body)).into_response())
}

/// Answers a `GET` (or `HEAD`) of `path` from the app directory `root`.
pub async fn serve_static(
    root: &Path,
    path: &str,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let Some(decoded) = decode_path(path) else {
        return Err(not_found());
    };
    let url_path = if decoded == "/" { INDEX_PATH.to_owned() } else { decoded };
    let file_path = join_url_path(root, &url_path);
    let inside = file_path.starts_with(root) && file_path != root;
    let content = if inside { read_if_file(&file_path).await } else { None };
    if let Some(content) = content {
        return file_response(&url_path, content, headers).await;
    }
    if url_path.starts_with(ASSETS_PREFIX) {
        return Err(not_found());
    }
    if let Some(index) = read_if_file(&join_url_path(root, INDEX_PATH)).await {
        return file_response(INDEX_PATH, index, headers).await;
    }
    if url_path == INDEX_PATH {
        let kind = [(header::CONTENT_TYPE, "text/plain; charset=UTF-8")];
        return Ok((kind, "bb server").into_response());
    }
    Err(not_found())
}

fn absolute_root(app_dir: &Path) -> PathBuf {
    let absolute = std::path::absolute(app_dir).unwrap_or_else(|_| app_dir.to_path_buf());
    let mut root = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                root.pop();
            }
            other => root.push(other),
        }
    }
    root
}

/// The app directory as a fallback service: `router.fallback_service(static_app(dir))`.
/// Methods other than `GET` and `HEAD` answer 404.
pub fn static_app(app_dir: impl AsRef<Path>) -> MethodRouter {
    let root = Arc::new(absolute_root(app_dir.as_ref()));
    any(move |request: Request| {
        let root = root.clone();
        async move {
            if request.method() != Method::GET && request.method() != Method::HEAD {
                return not_found().into_response();
            }
            match serve_static(&root, request.uri().path(), request.headers()).await {
                Ok(response) => response,
                Err(error) => error.into_response(),
            }
        }
    })
}
