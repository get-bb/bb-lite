#![allow(clippy::result_large_err)]

use axum::Router;
use axum::body::Body;
use axum::routing::{get, post};
use bb_server::error::ApiError;
use bb_server::http::api::{ApiJson, ApiPath, ApiQuery, ApiResponse};
use http::{Request, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tower::ServiceExt;

#[derive(Deserialize, Serialize)]
struct Draft {
    title: String,
    count: u32,
}

#[derive(Deserialize)]
struct Page {
    limit: u32,
}

async fn create(ApiJson(draft): ApiJson<Draft>) -> ApiResponse<Draft> {
    Ok(axum::Json(draft))
}

async fn page(ApiQuery(page): ApiQuery<Page>) -> ApiResponse<Value> {
    Ok(axum::Json(json!({"limit": page.limit})))
}

async fn thread(ApiPath((id, n)): ApiPath<(String, u32)>) -> ApiResponse<Value> {
    if id == "missing" {
        return Err(ApiError::new(404, "thread_not_found", "Thread not found"));
    }
    Ok(axum::Json(json!({"id": id, "n": n})))
}

fn app() -> Router {
    Router::new()
        .route("/drafts", post(create))
        .route("/page", get(page))
        .route("/threads/{id}/{n}", get(thread))
}

async fn send(request: Request<Body>) -> (StatusCode, Value) {
    let response = app().oneshot(request).await.unwrap();
    let status = response.status();
    let kind = response.headers().get("content-type").cloned();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(kind.unwrap(), "application/json");
    (status, serde_json::from_slice(&body).unwrap())
}

fn post_json(body: &str, kind: Option<&str>) -> Request<Body> {
    let mut request = Request::post("/drafts");
    if let Some(kind) = kind {
        request = request.header("content-type", kind);
    }
    request.body(Body::from(body.to_owned())).unwrap()
}

fn assert_invalid(answer: (StatusCode, Value), fragment: &str) {
    let (status, body) = answer;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_request");
    let message = body["message"].as_str().unwrap();
    assert!(message.contains(fragment), "{message:?} lacks {fragment:?}");
    assert_eq!(body.as_object().unwrap().len(), 2);
}

#[tokio::test]
async fn json_bodies() {
    let ok = send(post_json(r#"{"title":"a","count":2}"#, Some("application/json"))).await;
    assert_eq!(ok, (StatusCode::OK, json!({"title": "a", "count": 2})));
    let typed = r#"{"title":"a","count":"x"}"#;
    assert_invalid(send(post_json(typed, Some("application/json"))).await, "count");
    let missing = r#"{"title":"a"}"#;
    assert_invalid(send(post_json(missing, Some("application/json"))).await, "count");
    assert_invalid(
        send(post_json("{", Some("application/json"))).await,
        "Invalid JSON request body",
    );
    assert_invalid(send(post_json("{}", None)).await, "Invalid JSON request body");
    assert_invalid(send(post_json("{}", Some("text/plain"))).await, "Invalid JSON request body");
}

#[tokio::test]
async fn query_strings() {
    let ok = send(Request::get("/page?limit=5").body(Body::empty()).unwrap()).await;
    assert_eq!(ok, (StatusCode::OK, json!({"limit": 5})));
    let bad = Request::get("/page?limit=lots").body(Body::empty()).unwrap();
    assert_invalid(send(bad).await, "limit");
    assert_invalid(send(Request::get("/page").body(Body::empty()).unwrap()).await, "limit");
}

#[tokio::test]
async fn path_parameters() {
    let ok = send(Request::get("/threads/thr_1/3").body(Body::empty()).unwrap()).await;
    assert_eq!(ok, (StatusCode::OK, json!({"id": "thr_1", "n": 3})));
    let bad = Request::get("/threads/thr_1/three").body(Body::empty()).unwrap();
    assert_invalid(send(bad).await, "three");
    let missing = send(Request::get("/threads/missing/1").body(Body::empty()).unwrap()).await;
    let expected = json!({"code": "thread_not_found", "message": "Thread not found"});
    assert_eq!(missing, (StatusCode::NOT_FOUND, expected));
}
