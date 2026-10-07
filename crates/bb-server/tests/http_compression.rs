use std::io::Read;

use axum::body::{Body, Bytes};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use bb_server::error::ApiError;
use bb_server::http::compression::{
    Effort, Encoding, Uncompressed, accepted, compress, compress_json, compress_once, encode_static,
};
use http::{HeaderMap, HeaderValue, Request, StatusCode, header};
use serde_json::{Value, json};
use tower::ServiceExt;

fn decode(coding: Option<&str>, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    match coding {
        Some("br") => brotli::Decompressor::new(body, 4096).read_to_end(&mut out).unwrap(),
        Some("gzip") => flate2::read::GzDecoder::new(body).read_to_end(&mut out).unwrap(),
        _ => return body.to_vec(),
    };
    out
}

fn big() -> Value {
    json!({"rows": (0..100).map(|n| format!("row number {n}")).collect::<Vec<_>>()})
}

fn app() -> Router {
    Router::new()
        .route("/api/v1/config", get(|| async { Json(big()) }))
        .route("/api/v1/threads", get(|| async { Json(json!([])) }))
        .route("/api/v1/threads/thr_1/events/wait", get(|| async { Json(big()) }))
        .route("/api/v1/text", get(|| async { "x".repeat(5_000) }))
        .route(
            "/api/v1/plugin",
            get(|| async {
                let mut response = Json(big()).into_response();
                response.extensions_mut().insert(Uncompressed);
                response
            }),
        )
        .route(
            "/api/v1/created",
            get(|| async { (StatusCode::CREATED, [("x-extra", "1")], Json(big())) }),
        )
        .route(
            "/api/v1/error",
            get(|| async { Err::<(), _>(ApiError::new(409, "conflict", "y".repeat(2_000))) }),
        )
        .layer(axum::middleware::from_fn(compress_json))
}

async fn asked(path: &str, accept: Option<&str>) -> (Response, Vec<u8>) {
    let mut request = Request::get(path);
    if let Some(accept) = accept {
        request = request.header("accept-encoding", accept);
    }
    let response = app().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap().to_vec();
    let coding = parts.headers.get(header::CONTENT_ENCODING).map(|v| v.to_str().unwrap());
    let plain = decode(coding, &bytes);
    (Response::from_parts(parts, Body::empty()), plain)
}

fn mark(response: &Response, name: header::HeaderName) -> Option<&str> {
    response.headers().get(name).map(|v| v.to_str().unwrap())
}

#[test]
fn negotiates_encodings() {
    assert_eq!(accepted(None), None);
    assert_eq!(accepted(Some("identity")), None);
    assert_eq!(accepted(Some("gzip, deflate, br")), Some(Encoding::Br));
    assert_eq!(accepted(Some("gzip;q=1.0")), Some(Encoding::Gzip));
    assert_eq!(accepted(Some("brotli")), None);
    assert_eq!(accepted(Some("x-gzip")), Some(Encoding::Gzip));
    assert_eq!(accepted(Some("br;q=0")), Some(Encoding::Br));
}

#[test]
fn compresses_and_remembers_by_content() {
    let data = "hello hello hello ".repeat(100).into_bytes();
    for encoding in [Encoding::Br, Encoding::Gzip] {
        for effort in [Effort::Fast, Effort::Small] {
            let packed = compress(&data, encoding, effort).unwrap();
            assert_eq!(decode(Some(encoding.as_str()), &packed), data);
            let once = compress_once(&data, encoding, effort).unwrap();
            let again = compress_once(&data, encoding, effort).unwrap();
            assert!(std::sync::Arc::ptr_eq(&once, &again));
        }
    }
}

#[tokio::test]
async fn compresses_large_json_answers_and_leaves_others_alone() {
    let (plain, config) = asked("/api/v1/config", Some("identity")).await;
    assert_eq!(mark(&plain, header::CONTENT_ENCODING), None);
    assert_eq!(mark(&plain, header::VARY), None);
    assert!(config.len() >= 1024);
    for coding in ["br", "gzip"] {
        let (packed, body) = asked("/api/v1/config", Some(&format!("{coding}, deflate"))).await;
        assert_eq!(mark(&packed, header::CONTENT_ENCODING), Some(coding));
        assert_eq!(mark(&packed, header::VARY), Some("accept-encoding"));
        assert_eq!(mark(&packed, header::CONTENT_TYPE), Some("application/json"));
        assert_eq!(body, config);
    }
    let (none, body) = asked("/api/v1/config", None).await;
    assert_eq!((mark(&none, header::CONTENT_ENCODING), body), (None, config));
    let (small, body) = asked("/api/v1/threads", Some("br")).await;
    assert_eq!((mark(&small, header::CONTENT_ENCODING), mark(&small, header::VARY)), (None, None));
    assert_eq!(body, b"[]");
    for path in ["/api/v1/threads/thr_1/events/wait", "/api/v1/text", "/api/v1/plugin"] {
        let (untouched, _) = asked(path, Some("br")).await;
        assert_eq!(mark(&untouched, header::CONTENT_ENCODING), None, "{path}");
    }
    let (created, body) = asked("/api/v1/created", Some("gzip")).await;
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(mark(&created, "x-extra".parse().unwrap()), Some("1"));
    assert_eq!(mark(&created, header::CONTENT_ENCODING), Some("gzip"));
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), big());
    let (error, body) = asked("/api/v1/error", Some("br")).await;
    assert_eq!(error.status(), StatusCode::CONFLICT);
    assert_eq!(mark(&error, header::CONTENT_ENCODING), Some("br"));
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["code"], "conflict");
}

#[tokio::test]
async fn compresses_static_assets_by_type_and_size() {
    let encode = |kind: &'static str, size: usize, accept: Option<&'static str>| async move {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
        let content = Bytes::from(vec![b'a'; size]);
        let body = encode_static(content, &mut headers, accept).await.unwrap();
        let coding = headers.get(header::CONTENT_ENCODING).map(|v| v.to_str().unwrap().to_owned());
        let vary = headers.get(header::VARY).is_some();
        assert_eq!(decode(coding.as_deref(), &body).len(), size);
        (coding, vary)
    };
    let br = Some("br".to_owned());
    assert_eq!(encode("text/css; charset=utf-8", 1024, Some("br")).await, (br.clone(), true));
    assert_eq!(encode("text/css", 1023, Some("br")).await, (None, false));
    assert_eq!(
        encode("application/javascript", 2048, Some("gzip")).await,
        (Some("gzip".to_owned()), true)
    );
    assert_eq!(encode("application/manifest+json", 2048, Some("br")).await, (br.clone(), true));
    assert_eq!(encode("image/svg+xml", 2048, Some("br")).await, (br.clone(), true));
    assert_eq!(encode("application/wasm", 2048, Some("br")).await, (br, true));
    assert_eq!(encode("image/png", 2048, Some("br")).await, (None, false));
    assert_eq!(encode("text/html", 2048, None).await, (None, true));
    assert_eq!(encode("text/html", 2048, Some("identity")).await, (None, true));
}
