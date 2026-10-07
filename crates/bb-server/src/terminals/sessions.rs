//! Terminal sessions: the server's record of each PTY on a machine and the
//! WebSocket that carries its bytes. The port of
//! `apps/server/src/terminals/sessions.ts`.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use base64::Engine;
use bb_core::{RunnerErrorCode, RunnerEventBody, RunnerSnapshot};
use futures::{FutureExt, SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::context::Ctx;
use crate::db::RowValues;
use crate::db::terminals::{
    NewTerminal, get_terminal, insert_terminal, select_terminals, update_terminal,
};
use crate::db::threads::require_thread;
use crate::domain::changes::ThreadChangeKind;
use crate::domain::terminal::{
    TERMINAL_COLS_MAX, TERMINAL_DATA_MAX_BASE64_LENGTH, TERMINAL_ROWS_MAX, TerminalSession,
    TerminalSessionCloseReason, TerminalSessionStatus,
};
use crate::environments::workspace::{
    require_environment, require_ready_environment, require_thread_environment,
};
use crate::error::{ApiError, ApiErrorBody, ApiResult, error_message, invalid_request};
use crate::machine_environment::resolve_contributed_environment;
use crate::runners::hosts::require_host;
use crate::runners::registry::Registration;

pub const TERMINAL_REPLAY_MAX_BYTES: u64 = 512 * 1024;
pub const OUTPUT_READ_MAX_BYTES: u64 = 4 * 1024 * 1024;
const HOME_CWD: &str = "~";
const POLICY_VIOLATION_CLOSE_CODE: u16 = 1008;
const OPEN_ON_RUNNER: &str = "status IN ('starting', 'running')";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    pub seq: u64,
    pub data_base64: String,
}

/// `TerminalServerMessage`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TerminalServerMessage {
    #[serde(rename = "attached", rename_all = "camelCase")]
    Attached { session: TerminalSession, replay_start_seq: u64, next_seq: u64 },
    #[serde(rename = "output")]
    Output { chunk: TerminalOutputChunk },
    #[serde(rename = "session-updated")]
    SessionUpdated { session: TerminalSession },
    #[serde(rename = "exited")]
    Exited { session: TerminalSession },
    #[serde(rename = "error")]
    Error {
        #[serde(flatten)]
        body: ApiErrorBody,
    },
    #[serde(rename = "pong")]
    Pong,
}

/// `TerminalClientMessage`; `parse` applies the contract's limits.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum TerminalClientMessage {
    #[serde(rename = "input", rename_all = "camelCase")]
    Input { data_base64: String },
    #[serde(rename = "resize")]
    Resize { cols: i64, rows: i64 },
    #[serde(rename = "ping")]
    Ping {},
}

impl TerminalClientMessage {
    pub fn parse(raw: &str) -> Option<Self> {
        let message: Self = serde_json::from_str(raw).ok()?;
        let valid = match &message {
            Self::Input { data_base64 } => is_terminal_data(data_base64),
            Self::Resize { cols, rows } => valid_size(*cols, *rows),
            Self::Ping {} => true,
        };
        valid.then_some(message)
    }
}

fn is_terminal_data(data: &str) -> bool {
    !data.is_empty()
        && data.len() <= TERMINAL_DATA_MAX_BASE64_LENGTH
        && base64::engine::general_purpose::STANDARD.decode(data).is_ok()
}

fn valid_size(cols: i64, rows: i64) -> bool {
    (1..=TERMINAL_COLS_MAX).contains(&cols) && (1..=TERMINAL_ROWS_MAX).contains(&rows)
}

#[derive(Clone, Debug, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalListQuery {
    pub cwd: Option<String>,
    pub environment_id: Option<String>,
    pub host_id: Option<String>,
    pub thread_id: Option<String>,
}

impl TerminalListQuery {
    pub fn validate(mut self) -> ApiResult<Self> {
        self.cwd = self.cwd.map(|cwd| cwd.trim().to_owned());
        let scopes = [&self.thread_id, &self.environment_id, &self.host_id];
        let ids_valid = scopes.iter().all(|id| id.as_ref().is_none_or(|id| !id.is_empty()));
        if !ids_valid || self.cwd.as_ref().is_some_and(String::is_empty) {
            return Err(invalid_request("Invalid request"));
        }
        if scopes.iter().filter(|id| id.is_some()).count() != 1 {
            return Err(invalid_request(
                "Exactly one terminal scope must be provided: threadId, environmentId, or hostId",
            ));
        }
        if self.cwd.is_some() && self.host_id.is_none() {
            return Err(invalid_request("cwd can only be provided with hostId"));
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TerminalCreateTarget {
    #[serde(rename_all = "camelCase")]
    Thread { thread_id: String },
    #[serde(rename_all = "camelCase")]
    Environment { environment_id: String },
    #[serde(rename_all = "camelCase")]
    HostPath { host_id: String, cwd: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum TerminalStart {
    Shell,
    Command { command: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTerminalRequest {
    pub cols: i64,
    pub rows: i64,
    #[serde(default)]
    pub start: Option<TerminalStart>,
    pub target: TerminalCreateTarget,
    #[serde(default)]
    pub title: Option<String>,
}

impl CreateTerminalRequest {
    /// Trims and checks the fields as `createTerminalRequestSchema` does.
    pub fn validate(mut self) -> ApiResult<Self> {
        let invalid = || invalid_request("Invalid request");
        if !valid_size(self.cols, self.rows) {
            return Err(invalid());
        }
        if let Some(TerminalStart::Command { command }) = &mut self.start {
            *command = command.trim().to_owned();
            if command.is_empty() || command.chars().count() > 10_000 {
                return Err(invalid());
            }
        }
        match &mut self.target {
            TerminalCreateTarget::Thread { thread_id: id }
            | TerminalCreateTarget::Environment { environment_id: id }
                if id.is_empty() =>
            {
                return Err(invalid());
            }
            TerminalCreateTarget::HostPath { host_id, cwd } => {
                *cwd = cwd.as_ref().map(|cwd| cwd.trim().to_owned());
                if host_id.is_empty() || cwd.as_ref().is_some_and(String::is_empty) {
                    return Err(invalid());
                }
            }
            _ => {}
        }
        self.title = trimmed_title(self.title)?;
        Ok(self)
    }
}

fn trimmed_title(title: Option<String>) -> ApiResult<Option<String>> {
    let title = title.map(|title| title.trim().to_owned());
    match &title {
        Some(title) if title.is_empty() || title.chars().count() > 200 => {
            Err(invalid_request("Invalid request"))
        }
        _ => Ok(title),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseTerminalMode {
    Force,
    IfClean,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseTerminalRequest {
    pub mode: CloseTerminalMode,
    pub reason: TerminalSessionCloseReason,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateTerminalRequest {
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalInputRequest {
    pub data_base64: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalResizeRequest {
    pub cols: i64,
    pub rows: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalOutputQuery {
    pub since_seq: Option<u64>,
    pub tail_bytes: Option<u64>,
    pub limit_chunks: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputResponse {
    pub chunks: Vec<TerminalOutputChunk>,
    pub next_seq: u64,
    pub truncated: bool,
    pub status: TerminalSessionStatus,
    pub exit_code: Option<i64>,
    pub close_reason: Option<TerminalSessionCloseReason>,
}

/// The runner's `TerminalOpened`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub shell: String,
    pub title: String,
    pub initial_cwd: String,
    pub cols: i64,
    pub rows: i64,
}

/// The runner's `TerminalReplay`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReplay {
    pub chunks: Vec<TerminalOutputChunk>,
    pub replay_start_seq: u64,
    pub next_seq: u64,
    pub exited: Option<Value>,
}

/// The columns `change_terminal` may set; `None` leaves a column alone.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalPatch {
    pub status: Option<TerminalSessionStatus>,
    pub close_reason: Option<TerminalSessionCloseReason>,
    pub exit_code: Option<Option<i64>>,
    pub title: Option<String>,
    pub initial_cwd: Option<String>,
    pub cols: Option<i64>,
    pub rows: Option<i64>,
    pub last_user_input_at: Option<i64>,
}

impl TerminalPatch {
    fn status(status: TerminalSessionStatus) -> Self {
        Self { status: Some(status), ..Self::default() }
    }

    fn row(&self) -> RowValues {
        let mut row = RowValues::new()
            .set_some("status", self.status.map(TerminalSessionStatus::as_str))
            .set_some("closeReason", self.close_reason.map(TerminalSessionCloseReason::as_str))
            .set_some("title", self.title.as_deref())
            .set_some("initialCwd", self.initial_cwd.as_deref())
            .set_some("cols", self.cols)
            .set_some("rows", self.rows)
            .set_some("lastUserInputAt", self.last_user_input_at);
        if let Some(exit_code) = self.exit_code {
            row.put("exitCode", exit_code);
        }
        row
    }
}

/// Where a new terminal runs: `launchTarget` of the TypeScript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchTarget {
    pub thread_id: Option<String>,
    pub environment_id: Option<String>,
    pub host_id: String,
    pub project_id: Option<String>,
    pub cwd: Option<String>,
}

enum Outgoing {
    Frame(String),
    Close(u16, String),
}

struct Cursor {
    next_seq: u64,
    replaying: bool,
    backlog: Vec<TerminalOutputChunk>,
}

struct Client {
    id: u64,
    out: mpsc::UnboundedSender<Outgoing>,
    cursor: Mutex<Cursor>,
}

impl Client {
    fn send(&self, message: &TerminalServerMessage) {
        if let Ok(frame) = serde_json::to_string(message) {
            let _ = self.out.send(Outgoing::Frame(frame));
        }
    }

    fn fail(&self, code: &str, message: &str) {
        self.send(&error_message_frame(code, message));
        let _ = self.out.send(Outgoing::Close(POLICY_VIOLATION_CLOSE_CODE, code.to_owned()));
    }

    fn deliver(&self, chunk: TerminalOutputChunk) {
        {
            let mut cursor = self.cursor.lock();
            if chunk.seq < cursor.next_seq {
                return;
            }
            cursor.next_seq = chunk.seq + 1;
        }
        self.send(&TerminalServerMessage::Output { chunk });
    }
}

fn error_message_frame(code: &str, message: &str) -> TerminalServerMessage {
    let body = ApiErrorBody {
        code: code.to_owned(),
        message: message.to_owned(),
        details: None,
        retryable: None,
    };
    TerminalServerMessage::Error { body }
}

/// In-memory terminal state: the sockets attached to each terminal and which
/// of them owns its size.
#[derive(Default)]
pub struct TerminalsState {
    live: Mutex<Live>,
    next_client: AtomicU64,
}

#[derive(Default)]
struct Live {
    clients: HashMap<String, Vec<Arc<Client>>>,
    resize_owners: HashMap<String, u64>,
}

fn clients_of(ctx: &Ctx, terminal_id: &str) -> Vec<Arc<Client>> {
    ctx.terminals.live.lock().clients.get(terminal_id).cloned().unwrap_or_default()
}

fn error_frame(error: &ApiError) -> ApiErrorBody {
    if error.is_internal() {
        let message = error_message(error);
        return ApiErrorBody {
            code: "terminal_socket_error".to_owned(),
            message,
            details: None,
            retryable: None,
        };
    }
    error.body.clone()
}

fn announce(ctx: &Ctx, session: TerminalSession) -> TerminalSession {
    if let Some(thread_id) = &session.thread_id {
        ctx.hub.thread(thread_id, vec![ThreadChangeKind::TerminalsChanged], None);
    }
    let message = if session.status == TerminalSessionStatus::Exited {
        TerminalServerMessage::Exited { session: session.clone() }
    } else {
        TerminalServerMessage::SessionUpdated { session: session.clone() }
    };
    for client in clients_of(ctx, &session.id) {
        client.send(&message);
    }
    session
}

pub fn change_terminal(
    ctx: &Ctx,
    session: &TerminalSession,
    patch: TerminalPatch,
) -> ApiResult<TerminalSession> {
    let current = get_terminal(&ctx.db, &session.id)?.unwrap_or_else(|| session.clone());
    if current.status == TerminalSessionStatus::Exited && patch.status.is_some() {
        return Ok(current);
    }
    Ok(match update_terminal(&ctx.db, &session.id, &patch.row())? {
        Some(changed) => announce(ctx, changed),
        None => session.clone(),
    })
}

fn finish(
    ctx: &Ctx,
    session: &TerminalSession,
    close_reason: TerminalSessionCloseReason,
    exit_code: Option<i64>,
) -> ApiResult<TerminalSession> {
    let patch = TerminalPatch {
        status: Some(TerminalSessionStatus::Exited),
        close_reason: Some(close_reason),
        exit_code: Some(exit_code),
        ..TerminalPatch::default()
    };
    change_terminal(ctx, session, patch)
}

fn close_on_runner(ctx: &Ctx, host_id: &str, terminal_id: &str) {
    if let Ok(runner) = ctx.runners.get(host_id) {
        let params = json!({ "terminalId": terminal_id });
        tokio::spawn(async move {
            let _ = runner.call("closeTerminal", params).await;
        });
    }
}

fn end_terminal(
    ctx: &Ctx,
    session: &TerminalSession,
    close_reason: TerminalSessionCloseReason,
) -> ApiResult<TerminalSession> {
    if session.status != TerminalSessionStatus::Exited && ctx.runners.is_connected(&session.host_id)
    {
        close_on_runner(ctx, &session.host_id, &session.id);
    }
    finish(ctx, session, close_reason, None)
}

async fn attach_on_runner(
    ctx: &Ctx,
    host_id: &str,
    terminal_id: &str,
    since_seq: u64,
    tail_bytes: u64,
) -> Result<TerminalReplay, (ApiError, bool)> {
    let runner = ctx.runners.get(host_id).map_err(|error| (error, false))?;
    let params =
        json!({ "terminalId": terminal_id, "sinceSeq": since_seq, "tailBytes": tail_bytes });
    let page = runner.call("attachTerminal", params).await.map_err(|error| (error.into(), true))?;
    serde_json::from_value(page).map_err(|error| (error.into(), false))
}

async fn replay(ctx: Ctx, session: TerminalSession, client: Arc<Client>, greeting: bool) {
    let since_seq = {
        let mut cursor = client.cursor.lock();
        cursor.replaying = true;
        cursor.next_seq
    };
    let attached =
        attach_on_runner(&ctx, &session.host_id, &session.id, since_seq, TERMINAL_REPLAY_MAX_BYTES)
            .await;
    match attached {
        Ok(page) => {
            if greeting {
                let current = get_terminal(&ctx.db, &session.id).ok().flatten();
                client.send(&TerminalServerMessage::Attached {
                    session: current.unwrap_or_else(|| session.clone()),
                    replay_start_seq: page.replay_start_seq,
                    next_seq: page.next_seq,
                });
            }
            let backlog = {
                let mut cursor = client.cursor.lock();
                cursor.replaying = false;
                std::mem::take(&mut cursor.backlog)
            };
            for chunk in page.chunks.into_iter().chain(backlog) {
                client.deliver(chunk);
            }
        }
        Err((error, from_runner)) => {
            client.cursor.lock().replaying = false;
            let body = error_frame(&error);
            let lost = from_runner && body.code == RunnerErrorCode::TerminalNotFound.as_str();
            if lost {
                let _ = finish(&ctx, &session, TerminalSessionCloseReason::DaemonDisconnect, None);
            }
            client.fail(&body.code, &body.message);
        }
    }
}

fn resume(ctx: &Ctx, session: &TerminalSession) {
    for client in clients_of(ctx, &session.id) {
        tokio::spawn(replay(ctx.clone(), session.clone(), client, false));
    }
}

async fn reconcile(ctx: Ctx, host_id: String) -> ApiResult<()> {
    let lost = "host_id = ? AND status = 'disconnected'";
    let stale = select_terminals(&ctx.db, lost, [&host_id])?;
    if stale.is_empty() || !ctx.runners.is_connected(&host_id) {
        return Ok(());
    }
    let runner = ctx.runners.get(&host_id)?;
    let Ok(snapshot) = runner.call("snapshot", json!({})).await else {
        return Ok(());
    };
    let Ok(snapshot) = serde_json::from_value::<RunnerSnapshot>(snapshot) else {
        return Ok(());
    };
    for session in stale {
        if snapshot.terminal_ids.contains(&session.id) {
            let running = TerminalPatch::status(TerminalSessionStatus::Running);
            resume(&ctx, &change_terminal(&ctx, &session, running)?);
        } else {
            finish(&ctx, &session, TerminalSessionCloseReason::DaemonDisconnect, None)?;
        }
    }
    Ok(())
}

fn reattach(ctx: &Ctx, host_id: &str) {
    let ctx = ctx.clone();
    let host_id = host_id.to_owned();
    tokio::spawn(async move {
        if let Err(error) = reconcile(ctx.clone(), host_id.clone()).await {
            let fields = json!({ "err": error_message(&error), "hostId": host_id });
            ctx.log.warn("Terminal reconciliation failed", fields);
        }
    });
}

/// Keeps the terminal runner-event handlers registered; dropping it removes them.
pub struct TerminalSessionsGuard {
    _registrations: Vec<Registration>,
}

/// Marks terminals that were open as disconnected, registers the runner
/// event handlers and reconciles the local machine's terminals.
pub fn start_terminal_sessions(ctx: &Ctx) -> ApiResult<TerminalSessionsGuard> {
    ctx.db.run(
        &format!("UPDATE terminal_sessions SET status = 'disconnected' WHERE {OPEN_ON_RUNNER}"),
        [],
    )?;
    let output_ctx = ctx.clone();
    let output = ctx.runners.on_event(
        "terminal.output",
        Arc::new(move |event, _host_id| {
            if let (RunnerEventBody::TerminalOutput { terminal_id, data_base64 }, Some(seq)) =
                (event.body, event.seq)
            {
                let chunk = TerminalOutputChunk { seq, data_base64 };
                for client in clients_of(&output_ctx, &terminal_id) {
                    let mut cursor = client.cursor.lock();
                    if cursor.replaying {
                        cursor.backlog.push(chunk.clone());
                    } else {
                        drop(cursor);
                        client.deliver(chunk.clone());
                    }
                }
            }
            async { Ok(()) }.boxed()
        }),
    );
    let exited_ctx = ctx.clone();
    let exited = ctx.runners.on_event(
        "terminal.exited",
        Arc::new(move |event, host_id| {
            let result = match event.body {
                RunnerEventBody::TerminalExited { terminal_id, exit_code } => {
                    terminal_exited(&exited_ctx, &host_id, &terminal_id, exit_code.map(i64::from))
                }
                _ => Ok(()),
            };
            async move { result }.boxed()
        }),
    );
    let disconnected_ctx = ctx.clone();
    let disconnected = ctx.runners.on_disconnected(Arc::new(move |host_id| {
        let ctx = &disconnected_ctx;
        let open = format!("host_id = ? AND {OPEN_ON_RUNNER}");
        let Ok(sessions) = select_terminals(&ctx.db, &open, [host_id]) else {
            return;
        };
        for session in sessions {
            let disconnected = TerminalPatch::status(TerminalSessionStatus::Disconnected);
            let _ = change_terminal(ctx, &session, disconnected);
        }
    }));
    let connected_ctx = ctx.clone();
    let connected =
        ctx.runners.on_connected(Arc::new(move |host_id| reattach(&connected_ctx, host_id)));
    reattach(ctx, &ctx.config.host_id);
    Ok(TerminalSessionsGuard { _registrations: vec![output, exited, disconnected, connected] })
}

fn terminal_exited(
    ctx: &Ctx,
    host_id: &str,
    terminal_id: &str,
    exit_code: Option<i64>,
) -> ApiResult<()> {
    match get_terminal(&ctx.db, terminal_id)? {
        Some(session) if session.host_id == host_id => {
            finish(ctx, &session, TerminalSessionCloseReason::ProcessExit, exit_code)?;
            Ok(())
        }
        _ => Ok(()),
    }
}

pub fn require_terminal(ctx: &Ctx, terminal_id: &str) -> ApiResult<TerminalSession> {
    get_terminal(&ctx.db, terminal_id)?
        .ok_or_else(|| ApiError::new(404, "terminal_not_found", "Terminal session not found"))
}

fn not_running() -> ApiError {
    ApiError::new(409, "terminal_not_running", "Terminal session is not running")
}

pub fn require_running(ctx: &Ctx, terminal_id: &str) -> ApiResult<TerminalSession> {
    let session = require_terminal(ctx, terminal_id)?;
    if session.status == TerminalSessionStatus::Running {
        return Ok(session);
    }
    Err(not_running())
}

pub fn list_terminal_sessions(
    ctx: &Ctx,
    query: &TerminalListQuery,
) -> ApiResult<Vec<TerminalSession>> {
    let db = &ctx.db;
    let open = "status <> 'exited'";
    if let Some(thread_id) = &query.thread_id {
        require_thread(db, thread_id)?;
        return Ok(select_terminals(db, &format!("thread_id = ? AND {open}"), [thread_id])?);
    }
    let unowned = format!("thread_id IS NULL AND {open}");
    if let Some(environment_id) = &query.environment_id {
        let environment = require_environment(ctx, environment_id)?;
        let sql = format!("environment_id = ? AND {unowned}");
        return Ok(select_terminals(db, &sql, [&environment.id])?);
    }
    let host = require_host(ctx, query.host_id.as_deref().unwrap_or_default())?;
    let on_host = format!(
        "host_id = ? AND environment_id IS NULL AND {unowned}
    AND (? IS NULL OR initial_cwd = ?)"
    );
    let cwd = query.cwd.as_deref();
    Ok(select_terminals(db, &on_host, rusqlite::params![host.id, cwd, cwd])?)
}

pub fn launch_target(ctx: &Ctx, target: &TerminalCreateTarget) -> ApiResult<LaunchTarget> {
    let environment_id = match target {
        TerminalCreateTarget::HostPath { host_id, cwd } => {
            let host = require_host(ctx, host_id)?;
            return Ok(LaunchTarget {
                thread_id: None,
                environment_id: None,
                host_id: host.id,
                project_id: None,
                cwd: cwd.clone(),
            });
        }
        TerminalCreateTarget::Thread { thread_id } => {
            require_thread_environment(ctx, thread_id)?.id
        }
        TerminalCreateTarget::Environment { environment_id } => environment_id.clone(),
    };
    let environment = require_ready_environment(ctx, &environment_id)?;
    let thread_id = match target {
        TerminalCreateTarget::Thread { thread_id } => Some(thread_id.clone()),
        _ => None,
    };
    Ok(LaunchTarget {
        thread_id,
        environment_id: Some(environment.id),
        host_id: environment.host_id,
        project_id: Some(environment.project_id),
        cwd: environment.path,
    })
}

pub async fn create_terminal(
    ctx: &Ctx,
    payload: CreateTerminalRequest,
) -> ApiResult<TerminalSession> {
    let target = launch_target(ctx, &payload.target)?;
    let project_id = target.project_id.clone();
    let env = resolve_contributed_environment(ctx, project_id.as_deref());
    launch_terminal(ctx, target, payload, env).await
}

/// `createTerminal` after the target is resolved; `env` is awaited once the
/// session row exists, as the contributed environment is in the TypeScript.
pub async fn launch_terminal(
    ctx: &Ctx,
    target: LaunchTarget,
    payload: CreateTerminalRequest,
    env: impl Future<Output = ApiResult<BTreeMap<String, String>>>,
) -> ApiResult<TerminalSession> {
    let runner = ctx.runners.get(&target.host_id)?;
    let start = payload.start.clone().unwrap_or(TerminalStart::Shell);
    let new = NewTerminal {
        thread_id: target.thread_id,
        environment_id: target.environment_id,
        host_id: target.host_id,
        title: payload.title.clone().unwrap_or_else(|| "Terminal".to_owned()),
        initial_cwd: target.cwd.clone().unwrap_or_else(|| HOME_CWD.to_owned()),
        cols: payload.cols,
        rows: payload.rows,
    };
    let starting = announce(ctx, insert_terminal(&ctx.db, &new)?);
    let terminal_id = starting.id.clone();
    let opened = async {
        let env = env.await?;
        let launch = json!({
            "terminalId": terminal_id,
            "cwd": target.cwd,
            "cols": payload.cols,
            "rows": payload.rows,
            "start": start,
            "env": env,
        });
        let opened: TerminalOpened =
            serde_json::from_value(runner.call("openTerminal", launch).await?)?;
        let current = require_terminal(ctx, &terminal_id)?;
        if current.status != TerminalSessionStatus::Starting {
            let runner = runner.clone();
            let params = json!({ "terminalId": terminal_id });
            tokio::spawn(async move {
                let _ = runner.call("closeTerminal", params).await;
            });
            return Ok(current);
        }
        let patch = TerminalPatch {
            status: Some(TerminalSessionStatus::Running),
            cols: Some(opened.cols),
            rows: Some(opened.rows),
            initial_cwd: Some(opened.initial_cwd),
            title: Some(payload.title.clone().unwrap_or(opened.title)),
            ..TerminalPatch::default()
        };
        let running = change_terminal(ctx, &current, patch)?;
        resume(ctx, &running);
        Ok(running)
    };
    match opened.await {
        Ok(session) => Ok(session),
        Err(error) => {
            let _ = finish(ctx, &starting, TerminalSessionCloseReason::ProcessExit, None);
            Err(error)
        }
    }
}

pub fn close_terminal(
    ctx: &Ctx,
    terminal_id: &str,
    request: &CloseTerminalRequest,
) -> ApiResult<TerminalSession> {
    let session = require_terminal(ctx, terminal_id)?;
    let dirty = session.last_user_input_at.is_some();
    if request.mode == CloseTerminalMode::IfClean && dirty {
        return Ok(session);
    }
    end_terminal(ctx, &session, request.reason)
}

/// Closes every open terminal of a thread (`owner` = `"thread_id"`) or an
/// environment (`"environment_id"`); `reason` is a `TerminalSessionCloseReason` string.
pub fn close_terminals_for(ctx: &Ctx, owner: &str, owner_id: &str, reason: &str) {
    let column = match owner {
        "thread_id" => "thread_id",
        "environment_id" => "environment_id",
        _ => return,
    };
    let Ok(reason) = serde_json::from_value::<TerminalSessionCloseReason>(json!(reason)) else {
        return;
    };
    let open = format!("{column} = ? AND status <> 'exited'");
    let Ok(sessions) = select_terminals(&ctx.db, &open, [owner_id]) else {
        return;
    };
    for session in sessions {
        let _ = end_terminal(ctx, &session, reason);
    }
}

pub async fn write_terminal_input(
    ctx: &Ctx,
    session: &TerminalSession,
    data_base64: &str,
) -> ApiResult<TerminalSession> {
    let marked = if session.last_user_input_at.is_none() {
        let patch = TerminalPatch { last_user_input_at: Some(ctx.now()), ..Default::default() };
        change_terminal(ctx, session, patch)?
    } else {
        session.clone()
    };
    let params = json!({ "terminalId": session.id, "dataBase64": data_base64 });
    ctx.runners.get(&session.host_id)?.call("writeTerminal", params).await?;
    Ok(marked)
}

pub async fn resize_terminal(
    ctx: &Ctx,
    session: &TerminalSession,
    size: TerminalResizeRequest,
) -> ApiResult<TerminalSession> {
    let TerminalResizeRequest { cols, rows } = size;
    let resized = if session.cols == cols && session.rows == rows {
        session.clone()
    } else {
        let patch = TerminalPatch { cols: Some(cols), rows: Some(rows), ..Default::default() };
        change_terminal(ctx, session, patch)?
    };
    let params = json!({ "terminalId": session.id, "cols": cols, "rows": rows });
    ctx.runners.get(&session.host_id)?.call("resizeTerminal", params).await?;
    Ok(resized)
}

pub async fn read_terminal_output(
    ctx: &Ctx,
    terminal_id: &str,
    query: TerminalOutputQuery,
) -> ApiResult<TerminalOutputResponse> {
    let session = require_terminal(ctx, terminal_id)?;
    let unavailable = |reason: &str| ApiError::new(409, "terminal_output_unavailable", reason);
    if !matches!(session.status, TerminalSessionStatus::Running | TerminalSessionStatus::Exited) {
        return Err(unavailable("Terminal output can only be read once it has started"));
    }
    if !ctx.runners.is_connected(&session.host_id) {
        return Err(unavailable("The machine that ran this terminal is not connected"));
    }
    let since_seq = query.since_seq.unwrap_or(0);
    let tail_bytes = query.tail_bytes.unwrap_or(OUTPUT_READ_MAX_BYTES);
    let mut chunks: Vec<TerminalOutputChunk> = Vec::new();
    let mut from = since_seq;
    let mut next_seq;
    loop {
        let page = attach_on_runner(ctx, &session.host_id, terminal_id, from, tail_bytes)
            .await
            .map_err(|(error, _)| {
                if error_frame(&error).code == RunnerErrorCode::TerminalNotFound.as_str() {
                    unavailable("The machine no longer holds this terminal's output")
                } else {
                    error
                }
            })?;
        next_seq = page.next_seq;
        from = page.chunks.last().map_or(next_seq.saturating_sub(1), |chunk| chunk.seq) + 1;
        chunks.extend(page.chunks);
        if from >= next_seq {
            break;
        }
    }
    let keep = query.limit_chunks.unwrap_or(chunks.len()).min(chunks.len());
    let kept = chunks.split_off(chunks.len() - keep);
    let truncated = kept.first().map_or(next_seq, |chunk| chunk.seq) > since_seq;
    Ok(TerminalOutputResponse {
        chunks: kept,
        next_seq,
        truncated,
        status: session.status,
        exit_code: session.exit_code,
        close_reason: session.close_reason,
    })
}

fn receive(ctx: &Ctx, terminal_id: &str, client: &Arc<Client>, raw: &str) {
    let Some(message) = TerminalClientMessage::parse(raw) else {
        client.fail("invalid_message", "Invalid terminal message");
        return;
    };
    if message == (TerminalClientMessage::Ping {}) {
        client.send(&TerminalServerMessage::Pong);
        return;
    }
    let session = match get_terminal(&ctx.db, terminal_id) {
        Ok(Some(session)) if session.status != TerminalSessionStatus::Exited => session,
        _ => {
            client.send(&TerminalServerMessage::Error { body: not_running().body });
            return;
        }
    };
    if session.status != TerminalSessionStatus::Running {
        return;
    }
    let owner = ctx.terminals.live.lock().resize_owners.get(terminal_id) == Some(&client.id);
    if matches!(message, TerminalClientMessage::Resize { .. }) && !owner {
        return;
    }
    let ctx = ctx.clone();
    let client = client.clone();
    tokio::spawn(async move {
        let work = match message {
            TerminalClientMessage::Input { data_base64 } => {
                write_terminal_input(&ctx, &session, &data_base64).await
            }
            TerminalClientMessage::Resize { cols, rows } => {
                resize_terminal(&ctx, &session, TerminalResizeRequest { cols, rows }).await
            }
            TerminalClientMessage::Ping {} => return,
        };
        if let Err(error) = work {
            client.send(&TerminalServerMessage::Error { body: error_frame(&error) });
        }
    });
}

fn detach(ctx: &Ctx, terminal_id: &str, client_id: u64) {
    let mut live = ctx.terminals.live.lock();
    let Live { clients, resize_owners } = &mut *live;
    let heir = clients.get_mut(terminal_id).and_then(|attached| {
        attached.retain(|client| client.id != client_id);
        attached.first().map(|client| client.id)
    });
    if heir.is_none() {
        clients.remove(terminal_id);
    }
    if resize_owners.get(terminal_id) != Some(&client_id) {
        return;
    }
    match heir {
        Some(heir) => resize_owners.insert(terminal_id.to_owned(), heir),
        None => resize_owners.remove(terminal_id),
    };
}

/// Serves one terminal WebSocket until it closes: replays output from
/// `since_seq`, then streams live output and session changes, and takes
/// input, resize and ping messages.
pub async fn attach_terminal_socket(
    ctx: Ctx,
    terminal_id: String,
    since_seq: u64,
    socket: WebSocket,
) {
    let (mut sink, mut stream) = socket.split();
    let (out, mut outgoing) = mpsc::unbounded_channel::<Outgoing>();
    let writer = tokio::spawn(async move {
        while let Some(item) = outgoing.recv().await {
            let message = match item {
                Outgoing::Frame(frame) => Message::Text(frame.into()),
                Outgoing::Close(code, reason) => {
                    let frame = CloseFrame { code, reason: reason.into() };
                    let _ = sink.send(Message::Close(Some(frame))).await;
                    break;
                }
            };
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });
    let id = ctx.terminals.next_client.fetch_add(1, Ordering::Relaxed);
    let cursor = Cursor { next_seq: since_seq, replaying: false, backlog: Vec::new() };
    let client = Arc::new(Client { id, out, cursor: Mutex::new(cursor) });
    let session = match get_terminal(&ctx.db, &terminal_id) {
        Ok(Some(session)) => session,
        _ => {
            client.fail("terminal_not_found", "Terminal session not found");
            drop(client);
            let _ = writer.await;
            return;
        }
    };
    {
        let mut live = ctx.terminals.live.lock();
        live.clients.entry(terminal_id.clone()).or_default().push(client.clone());
        live.resize_owners.insert(terminal_id.clone(), id);
    }
    if session.status == TerminalSessionStatus::Running {
        tokio::spawn(replay(ctx.clone(), session, client.clone(), true));
    } else {
        let exited = session.status == TerminalSessionStatus::Exited;
        let held = if exited { 0 } else { since_seq };
        client.send(&TerminalServerMessage::Attached {
            session: session.clone(),
            replay_start_seq: held,
            next_seq: held,
        });
        if exited {
            client.send(&TerminalServerMessage::Exited { session });
        }
    }
    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => receive(&ctx, &terminal_id, &client, text.as_str()),
            Message::Binary(bytes) => {
                receive(&ctx, &terminal_id, &client, &String::from_utf8_lossy(&bytes))
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    detach(&ctx, &terminal_id, id);
    drop(client);
    writer.abort();
}
