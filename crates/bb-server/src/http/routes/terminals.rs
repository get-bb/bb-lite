//! The port of `apps/server/src/http/routes/terminals.ts`.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use http::StatusCode;

use crate::context::Ctx;
use crate::domain::terminal::{TerminalListResponse, TerminalSession};
use crate::error::ApiError;
use crate::http::api::{ApiJson, ApiPath, ApiQuery, ApiResponse};
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

async fn list(
    State(ctx): State<Ctx>,
    ApiQuery(query): ApiQuery<TerminalListQuery>,
) -> ApiResponse<TerminalListResponse> {
    let query = query.validate()?;
    Ok(Json(TerminalListResponse { sessions: sessions::list_terminal_sessions(&ctx, &query)? }))
}

async fn create(
    State(ctx): State<Ctx>,
    ApiJson(payload): ApiJson<CreateTerminalRequest>,
) -> Result<(StatusCode, Json<TerminalSession>), ApiError> {
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
    ApiJson(UpdateTerminalRequest { title }): ApiJson<UpdateTerminalRequest>,
) -> ApiResponse<TerminalSession> {
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
    ApiJson(payload): ApiJson<CloseTerminalRequest>,
) -> ApiResponse<TerminalSession> {
    if payload.reason != crate::domain::terminal::TerminalSessionCloseReason::User {
        return Err(crate::error::invalid_request("Invalid request"));
    }
    Ok(Json(sessions::close_terminal(&ctx, &terminal_id, &payload)?))
}

async fn input(
    State(ctx): State<Ctx>,
    ApiPath(terminal_id): ApiPath<String>,
    ApiJson(TerminalInputRequest { data_base64 }): ApiJson<TerminalInputRequest>,
) -> ApiResponse<TerminalSession> {
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
    ApiQuery(query): ApiQuery<TerminalOutputQuery>,
) -> ApiResponse<TerminalOutputResponse> {
    let tail_valid = query.tail_bytes.is_none_or(|bytes| (1..=4 * 1024 * 1024).contains(&bytes));
    let limit_valid = query.limit_chunks.is_none_or(|limit| (1..=10_000).contains(&limit));
    if !tail_valid || !limit_valid {
        return Err(crate::error::invalid_request("Invalid request"));
    }
    Ok(Json(sessions::read_terminal_output(&ctx, &terminal_id, query).await?))
}
