//! The port of `apps/server/src/http/routes/terminals.ts`.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use http::StatusCode;

use crate::context::Ctx;
use crate::domain::terminal::{TerminalListResponse, TerminalSession};
use crate::error::ApiError;
use crate::error::invalid_request;
use crate::http::api::{ApiJson, ApiPath, ApiQuery, ApiResponse};
use crate::http::validate::{
    Field, Kind, NON_EMPTY, check_object, coerce_query_numbers, decode, invalid_literal, req,
    opt, trim_fields, unknown_key,
};
use serde_json::{Map, Value};
use crate::terminals::sessions::{
    self, CloseTerminalRequest, CreateTerminalRequest, TerminalInputRequest, TerminalListQuery,
    TerminalOutputQuery, TerminalOutputResponse, TerminalPatch, UpdateTerminalRequest,
};

pub fn terminal_routes() -> Router<Ctx> {
    Router::new()
        .route("/terminals", get(list).post(create))
        .route("/terminals/{terminal_id}", get(read).patch(update))
        .route("/terminals/{terminal_id}/close", post(close))
        .route("/terminals/{terminal_id}/input", post(input))
        .route("/terminals/{terminal_id}/output", get(output))
}

const LIST_FIELDS: &[Field] = &[
    opt("cwd", NON_EMPTY),
    opt("environmentId", NON_EMPTY),
    opt("hostId", NON_EMPTY),
    opt("threadId", NON_EMPTY),
];

const TITLE: Kind = Kind::Str { min: 1, max: Some(200) };

const fn dimension(max: i64) -> Kind {
    Kind::Int { min: None, max: Some(max), positive: true }
}

const CREATE_FIELDS: &[Field] = &[
    req("cols", dimension(500)),
    req("rows", dimension(200)),
    opt("start", Kind::Object),
    req("target", Kind::Object),
    opt("title", TITLE),
];

/// `terminalDataBase64Schema`'s pattern: padded base64.
fn is_padded_base64(text: &str) -> bool {
    let body = text.trim_end_matches('=');
    text.len() % 4 == 0
        && text.len() - body.len() <= 2
        && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

async fn list(
    State(ctx): State<Ctx>,
    ApiQuery(query): ApiQuery<Map<String, Value>>,
) -> ApiResponse<TerminalListResponse> {
    let query = Value::Object(query);
    check_object(&trim_fields(&query, &["cwd"]), LIST_FIELDS, true).map_err(invalid_request)?;
    let query: TerminalListQuery = decode(query).map_err(invalid_request)?;
    let query = query.validate()?;
    Ok(Json(TerminalListResponse { sessions: sessions::list_terminal_sessions(&ctx, &query)? }))
}

async fn create(
    State(ctx): State<Ctx>,
    ApiJson(payload): ApiJson<Value>,
) -> Result<(StatusCode, Json<TerminalSession>), ApiError> {
    check_object(&trim_fields(&payload, &["title"]), CREATE_FIELDS, true)
        .map_err(invalid_request)?;
    let payload: CreateTerminalRequest = decode(payload).map_err(invalid_request)?;
    let session = sessions::create_terminal(&ctx, payload.validate()?).await?;
    Ok((StatusCode::CREATED, Json(session)))
}

async fn read(
    State(ctx): State<Ctx>,
    ApiPath(terminal_id): ApiPath<String>,
) -> ApiResponse<TerminalSession> {
    Ok(Json(sessions::require_terminal(&ctx, &terminal_id)?))
}

async fn update(
    State(ctx): State<Ctx>,
    ApiPath(terminal_id): ApiPath<String>,
    ApiJson(payload): ApiJson<Value>,
) -> ApiResponse<TerminalSession> {
    check_object(&trim_fields(&payload, &["title"]), &[req("title", TITLE)], true)
        .map_err(invalid_request)?;
    let UpdateTerminalRequest { title } = decode(payload).map_err(invalid_request)?;
    let title = title.trim().to_owned();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(crate::error::invalid_request("Invalid request"));
    }
    let session = sessions::require_terminal(&ctx, &terminal_id)?;
    let patch = TerminalPatch { title: Some(title), ..TerminalPatch::default() };
    Ok(Json(sessions::change_terminal(&ctx, &session, patch)?))
}

async fn close(
    State(ctx): State<Ctx>,
    ApiPath(terminal_id): ApiPath<String>,
    ApiJson(payload): ApiJson<Value>,
) -> ApiResponse<TerminalSession> {
    let mode = Kind::Enum(&["force", "if-clean"]);
    check_object(&payload, &[req("mode", mode)], false).map_err(invalid_request)?;
    if payload.get("reason") != Some(&Value::from("user")) {
        return Err(invalid_request(invalid_literal(&Value::from("user"))));
    }
    if let Some(message) = payload.as_object().and_then(|o| unknown_key(o, &["mode", "reason"])) {
        return Err(invalid_request(message));
    }
    let payload: CloseTerminalRequest = decode(payload).map_err(invalid_request)?;
    if payload.reason != crate::domain::terminal::TerminalSessionCloseReason::User {
        return Err(crate::error::invalid_request("Invalid request"));
    }
    Ok(Json(sessions::close_terminal(&ctx, &terminal_id, &payload)?))
}

async fn input(
    State(ctx): State<Ctx>,
    ApiPath(terminal_id): ApiPath<String>,
    ApiJson(payload): ApiJson<Value>,
) -> ApiResponse<TerminalSession> {
    let data = Kind::Str { min: 1, max: Some(87_384) };
    check_object(&payload, &[req("dataBase64", data)], false).map_err(invalid_request)?;
    if !payload["dataBase64"].as_str().is_some_and(is_padded_base64) {
        return Err(invalid_request(
            "Invalid string: must match pattern \
             /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u",
        ));
    }
    if let Some(message) = payload.as_object().and_then(|o| unknown_key(o, &["dataBase64"])) {
        return Err(invalid_request(message));
    }
    let TerminalInputRequest { data_base64 } = decode(payload).map_err(invalid_request)?;
    let message = format!(r#"{{"type":"input","dataBase64":{}}}"#, serde_json::json!(data_base64));
    if sessions::TerminalClientMessage::parse(&message).is_none() {
        return Err(crate::error::invalid_request("Invalid request"));
    }
    let session = sessions::require_running(&ctx, &terminal_id)?;
    Ok(Json(sessions::write_terminal_input(&ctx, &session, &data_base64).await?))
}

async fn output(
    State(ctx): State<Ctx>,
    ApiPath(terminal_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<Map<String, Value>>,
) -> ApiResponse<TerminalOutputResponse> {
    let keys = ["sinceSeq", "tailBytes", "limitChunks"];
    let query = coerce_query_numbers(&query, &keys).map_err(invalid_request)?;
    let fields = &[
        opt("sinceSeq", Kind::Int { min: Some(0), max: None, positive: false }),
        opt("tailBytes", dimension(4 * 1024 * 1024)),
        opt("limitChunks", dimension(10_000)),
    ];
    check_object(&query, fields, true).map_err(invalid_request)?;
    let query: TerminalOutputQuery = decode(query).map_err(invalid_request)?;
    let tail_valid = query.tail_bytes.is_none_or(|bytes| (1..=4 * 1024 * 1024).contains(&bytes));
    let limit_valid = query.limit_chunks.is_none_or(|limit| (1..=10_000).contains(&limit));
    if !tail_valid || !limit_valid {
        return Err(crate::error::invalid_request("Invalid request"));
    }
    Ok(Json(sessions::read_terminal_output(&ctx, &terminal_id, query).await?))
}
