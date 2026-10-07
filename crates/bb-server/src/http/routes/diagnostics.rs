use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;

use crate::context::Ctx;
use crate::diagnostics::{memory_report, trim_memory};

async fn memory(State(ctx): State<Ctx>) -> Json<Value> {
    Json(memory_report(&ctx))
}

async fn trim() -> Json<Value> {
    Json(trim_memory())
}

/// Mounted under `/internal`, which only the owner reaches.
pub fn diagnostics_routes() -> Router<Ctx> {
    Router::new()
        .route("/diagnostics/memory", get(memory))
        .route("/diagnostics/memory/trim", post(trim))
}
