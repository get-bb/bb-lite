//! The server's three WebSocket endpoints: `/ws` (change notifications),
//! `/ws/terminals/{id}` (terminal bytes) and `/internal/runner/ws` (remote
//! runners). The trust guard has already admitted the request.

use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use http::HeaderMap;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::context::Ctx;
use crate::error::{ApiError, ApiResult};
use crate::http::trust::{Principal, request_header};
use crate::runners::enrollment::authenticate_runner;
use crate::runners::remote::{attach_remote_runner, axum_wire_socket};
use crate::terminals::sessions::attach_terminal_socket;
use crate::ws::hub::HubSocket;

const SHUTDOWN_CLOSE_CODE: u16 = 1001;

/// Cancelled when the server closes, so open sockets say goodbye.
#[derive(Clone, Default)]
pub struct SocketShutdown(pub CancellationToken);

enum Outbound {
    Text(String),
    Close(u16, String),
}

struct ClientSocket {
    outbound: mpsc::UnboundedSender<Outbound>,
}

impl HubSocket for ClientSocket {
    fn send(&self, data: String) -> bool {
        self.outbound.send(Outbound::Text(data)).is_ok()
    }

    fn close(&self, code: u16, reason: &str) {
        let _ = self.outbound.send(Outbound::Close(code, reason.to_owned()));
    }
}

fn close_frame(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code, reason: reason.to_owned().into() }))
}

async fn serve_hub_socket(ctx: Ctx, socket: WebSocket, shutdown: CancellationToken) {
    let (mut sink, mut stream) = socket.split();
    let (outbound, mut pending) = mpsc::unbounded_channel();
    let id = ctx.hub.connect(Arc::new(ClientSocket { outbound }));
    loop {
        tokio::select! {
            () = shutdown.cancelled() => {
                let _ = sink.send(close_frame(SHUTDOWN_CLOSE_CODE, "server-shutdown")).await;
                break;
            }
            next = pending.recv() => match next {
                Some(Outbound::Text(text)) => {
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Some(Outbound::Close(code, reason)) => {
                    let _ = sink.send(close_frame(code, &reason)).await;
                    break;
                }
                None => break,
            },
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => ctx.hub.receive(id, text.as_str()),
                Some(Ok(Message::Binary(bytes))) => {
                    ctx.hub.receive(id, &String::from_utf8_lossy(&bytes));
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
    ctx.hub.disconnect(id);
}

pub async fn hub_socket(
    State(ctx): State<Ctx>,
    axum::Extension(shutdown): axum::Extension<SocketShutdown>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| serve_hub_socket(ctx, socket, shutdown.0))
}

#[derive(Deserialize)]
pub struct TerminalSocketQuery {
    #[serde(rename = "sinceSeq")]
    since_seq: Option<String>,
}

fn since_seq(query: &TerminalSocketQuery) -> ApiResult<u64> {
    let Some(text) = query.since_seq.as_deref() else { return Ok(0) };
    let digits = !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    digits.then(|| text.parse().ok()).flatten().ok_or_else(|| {
        ApiError::new(
            400,
            "invalid_terminal_socket_query",
            "Terminal websocket sinceSeq must be a non-negative integer",
        )
    })
}

pub async fn terminal_socket(
    State(ctx): State<Ctx>,
    Path(terminal_id): Path<String>,
    Query(query): Query<TerminalSocketQuery>,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    let since_seq = since_seq(&query)?;
    Ok(upgrade
        .on_upgrade(move |socket| attach_terminal_socket(ctx, terminal_id, since_seq, socket)))
}

pub async fn runner_socket(
    State(ctx): State<Ctx>,
    principal: Principal,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    let authorization = request_header(&headers, "authorization");
    let host = authenticate_runner(&ctx.db, authorization.as_deref(), &principal)?;
    Ok(upgrade.on_upgrade(move |socket| async move {
        attach_remote_runner(&ctx, &host.id, axum_wire_socket(socket));
    }))
}
