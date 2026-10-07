//! The HTTP application (`createHttpApp`): health, the public API, the runner API, the
//! WebSockets and the web app, behind the trust guard.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::middleware::{Next, from_fn, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde_json::json;

use crate::context::Ctx;
use crate::error::{ApiError, not_found};
use crate::http::compression::compress_json;
use crate::http::routes;
use crate::http::static_app::static_app;
use crate::http::trust::{RunnerMachine, SharedTrust, TrustLookups, trust_guard};
use crate::runners::enrollment::find_runner_host;
use crate::runners::hosts::public_server_url;
use crate::ws::sockets::{SocketShutdown, hub_socket, runner_socket, terminal_socket};

/// `trustLookups`: what the trust guard asks the server.
pub struct ServerTrust {
    ctx: Ctx,
}

impl TrustLookups for ServerTrust {
    fn allowed_hosts(&self) -> Vec<String> {
        self.ctx.config.allowed_hosts.clone()
    }

    fn public_url(&self) -> Option<String> {
        public_server_url(&self.ctx).ok().flatten()
    }

    fn runner_machine(&self, token: &str) -> Option<RunnerMachine> {
        let host = find_runner_host(&self.ctx.db, token).ok().flatten()?;
        Some(RunnerMachine { connect_machine_id: host.connect_machine_id })
    }
}

pub fn trust_lookups(ctx: &Ctx) -> SharedTrust {
    Arc::new(ServerTrust { ctx: ctx.clone() })
}

fn public_api() -> Router<Ctx> {
    Router::new()
        .merge(routes::settings::register_settings_routes())
        .merge(routes::projects::register_project_routes())
        .merge(routes::hosts::register_host_routes())
        .merge(routes::providers::provider_routes())
        .merge(routes::plugins::router())
        .merge(routes::environments::register_environment_routes())
        .merge(routes::files::register_file_routes())
        .merge(routes::terminals::terminal_routes())
        .merge(routes::threads::thread_routes())
        .merge(routes::thread_read::thread_read_routes())
}

async fn api_not_found() -> Response {
    not_found().into_response()
}

async fn log_failures(State(ctx): State<Ctx>, request: Request, next: Next) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let response = next.run(request).await;
    if let Some(ApiError { cause: Some(cause), .. }) = response.extensions().get::<ApiError>() {
        ctx.log.error("Request failed", json!({ "err": cause, "method": method, "path": path }));
    }
    response
}

/// `createHttpApp`. Serve it with `into_make_service_with_connect_info::<SocketAddr>()` so the
/// trust guard sees the peer address.
pub fn create_http_app(ctx: &Ctx, shutdown: SocketShutdown) -> Router {
    let version = ctx.config.version.clone();
    let api = public_api().fallback(api_not_found).layer(from_fn(compress_json));
    let internal = routes::hosts::register_runner_routes()
        .merge(routes::diagnostics::diagnostics_routes())
        .fallback(api_not_found);
    Router::new()
        .route(
            "/health",
            get(move || async move { Json(json!({ "ok": true, "version": version })) }),
        )
        .nest("/api/v1", api)
        .nest("/internal", internal)
        .route("/ws", get(hub_socket))
        .route("/ws/terminals/{id}", get(terminal_socket))
        .route("/internal/runner/ws", get(runner_socket))
        .fallback_service(static_app(&ctx.config.app_dir))
        .layer(Extension(shutdown))
        .layer(from_fn_with_state(ctx.clone(), log_failures))
        .layer(from_fn_with_state(trust_lookups(ctx), trust_guard))
        .with_state(ctx.clone())
}
