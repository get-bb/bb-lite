use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::hash::{BuildHasher, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use bb_core::env::EnvMap;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::AbortHandle;

use crate::mcp::McpServer;

pub const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_millis(60_000);
pub const CLOSE_INTERRUPT_TIMEOUT: Duration = Duration::from_millis(5_000);
pub const CLOSE_SIGTERM_AFTER: Duration = Duration::from_millis(2_000);
pub const CLOSE_SIGKILL_AFTER: Duration = Duration::from_millis(5_000);
pub const STDERR_TAIL_LINES: usize = 50;
const STDOUT_DRAIN_AFTER_EXIT: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillSignal {
    Term,
    Kill,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChildExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub error: Option<String>,
}

/// One `claude` process as the client sees it; tests build this from in-memory pipes.
pub struct ClaudeChild {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub stderr: Box<dyn AsyncRead + Send + Unpin>,
    pub exit: BoxFuture<'static, ChildExit>,
    pub signal: Box<dyn Fn(KillSignal) + Send + Sync>,
}

fn signal_name(signal: i32) -> String {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGABRT => "SIGABRT",
        libc::SIGKILL => "SIGKILL",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGTERM => "SIGTERM",
        other => return format!("SIG{other}"),
    };
    name.to_owned()
}

fn failed_child(message: String) -> ClaudeChild {
    ClaudeChild {
        stdin: Box::new(tokio::io::sink()),
        stdout: Box::new(tokio::io::empty()),
        stderr: Box::new(tokio::io::empty()),
        exit: Box::pin(async move { ChildExit { code: None, signal: None, error: Some(message) } }),
        signal: Box::new(|_| {}),
    }
}

/// Spawns `executable args` in `cwd` with exactly `env`, piped stdio and `kill_on_drop`.
/// A spawn failure becomes a child that exits immediately with `error` set.
pub fn spawn_claude(executable: &str, args: &[String], cwd: &str, env: &EnvMap) -> ClaudeChild {
    let mut builder = tokio::process::Command::new(executable);
    builder.args(args).current_dir(cwd).env_clear().envs(env).kill_on_drop(true);
    builder.stdin(std::process::Stdio::piped());
    builder.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = match builder.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = match error.kind() {
                std::io::ErrorKind::NotFound => format!("spawn {executable} ENOENT"),
                std::io::ErrorKind::PermissionDenied => format!("spawn {executable} EACCES"),
                _ => format!("spawn {executable} {error}"),
            };
            return failed_child(message);
        }
    };
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return failed_child(format!("spawn {executable} EPIPE"));
    };
    let pid = child.id();
    let (signals, mut received) = mpsc::unbounded_channel::<KillSignal>();
    let exit = Box::pin(async move {
        loop {
            tokio::select! {
                status = child.wait() => {
                    return match status {
                        Ok(status) => {
                            use std::os::unix::process::ExitStatusExt;
                            let signal = status.signal().map(signal_name);
                            ChildExit { code: status.code(), signal, error: None }
                        }
                        Err(error) => ChildExit { error: Some(error.to_string()), ..ChildExit::default() },
                    };
                }
                Some(signal) = received.recv() => match (signal, pid) {
                    (KillSignal::Term, Some(pid)) => {
                        let pid = libc::pid_t::try_from(pid).unwrap_or(0);
                        if pid > 0 {
                            unsafe { libc::kill(pid, libc::SIGTERM) };
                        }
                    }
                    _ => {
                        let _ = child.start_kill();
                    }
                },
            }
        }
    });
    ClaudeChild {
        stdin: Box::new(stdin),
        stdout: Box::new(stdout),
        stderr: Box::new(stderr),
        exit,
        signal: Box::new(move |signal| {
            let _ = signals.send(signal);
        }),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<String>,
    /// Set when the process could not be spawned or waited on.
    pub error: Option<String>,
    pub stderr_tail: String,
}

impl ExitInfo {
    /// The SDK's wording: `Claude Code process exited with code N. stderr: <tail>`.
    pub fn message(&self) -> String {
        let head = match (&self.error, self.code, &self.signal) {
            (Some(error), _, _) => format!("Failed to spawn Claude Code process: {error}"),
            (None, Some(code), _) => format!("Claude Code process exited with code {code}"),
            (None, None, Some(signal)) => {
                format!("Claude Code process terminated by signal {signal}")
            }
            (None, None, None) => "Claude Code process exited".to_owned(),
        };
        if self.stderr_tail.is_empty() {
            head
        } else {
            format!("{head}. stderr: {}", self.stderr_tail)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeError {
    /// The CLI answered with `{"subtype":"error","error":...}`.
    Response(String),
    Timeout(String),
    Exited(String),
    Closed,
}

impl fmt::Display for ClaudeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Response(message) | Self::Exited(message) => f.write_str(message),
            Self::Timeout(subtype) => write!(f, "Control request timeout: {subtype}"),
            Self::Closed => f.write_str("Claude Code process is closed"),
        }
    }
}

impl std::error::Error for ClaudeError {}

/// The `can_use_tool` request from the CLI. `raw` is the whole `request` object.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct CanUseToolRequest {
    #[serde(default)]
    pub tool_name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub permission_suggestions: Option<Vec<Value>>,
    #[serde(default)]
    pub decision_reason: Option<String>,
    #[serde(default)]
    pub decision_reason_type: Option<String>,
    #[serde(default)]
    pub blocked_path: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(skip)]
    pub raw: Value,
}

/// A permission answer. Serializes as the recordings show, with `toolUseID` added by the client.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "behavior", rename_all = "camelCase")]
pub enum PermissionDecision {
    #[serde(rename_all = "camelCase")]
    Allow {
        updated_input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Vec<Value>>,
        decision_classification: String,
    },
    #[serde(rename_all = "camelCase")]
    Deny {
        message: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        interrupt: bool,
        decision_classification: String,
    },
}

impl PermissionDecision {
    /// Allow once (`decisionClassification: "user_temporary"`).
    pub fn allow(updated_input: Value) -> Self {
        Self::Allow {
            updated_input,
            updated_permissions: None,
            decision_classification: "user_temporary".to_owned(),
        }
    }

    /// Deny (`decisionClassification: "user_reject"`).
    pub fn deny(message: impl Into<String>) -> Self {
        Self::Deny {
            message: message.into(),
            interrupt: false,
            decision_classification: "user_reject".to_owned(),
        }
    }

    pub fn to_response(&self, tool_use_id: Option<&str>) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or_else(|_| json!({}));
        if let (Some(id), Value::Object(object)) = (tool_use_id, &mut value) {
            object.insert("toolUseID".to_owned(), Value::String(id.to_owned()));
        }
        value
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    /// `{"PreToolUse":[{"hookCallbackIds":["hook_0"],"matcher"?:..}]}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hooks: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdk_mcp_servers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json_schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<Value>,
    /// Further fields copied verbatim into the request.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Callbacks for one client. Async handlers run on their own task, never on the read loop.
#[async_trait]
pub trait ClaudeHandlers: Send + Sync {
    /// Every stdout line that is not a control message, in order.
    fn on_message(&self, message: Value);
    async fn can_use_tool(&self, request: CanUseToolRequest) -> PermissionDecision;
    /// The whole `can_use_tool` response body; override when a `PermissionDecision` cannot
    /// express the answer (an absent `decisionClassification`).
    async fn can_use_tool_response(&self, request: CanUseToolRequest) -> Value {
        let tool_use_id = request.tool_use_id.clone();
        self.can_use_tool(request).await.to_response(tool_use_id.as_deref())
    }
    /// `Err(message)` becomes an error control_response.
    async fn hook_callback(
        &self,
        callback_id: String,
        input: Value,
        tool_use_id: Option<String>,
    ) -> Result<Value, String>;
    /// Called once when the process exits, unless `close()` was called first.
    fn on_exit(&self, exit: ExitInfo);
}

#[derive(Clone)]
pub struct ClientOptions {
    pub request_timeout: Duration,
    pub mcp_servers: Vec<Arc<McpServer>>,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self { request_timeout: CONTROL_REQUEST_TIMEOUT, mcp_servers: Vec::new() }
    }
}

type Reply = oneshot::Sender<Result<Value, ClaudeError>>;

/// A control response that is already on the wire; await it now or later.
pub type ControlResponse = BoxFuture<'static, Result<Value, ClaudeError>>;

struct Inner {
    handlers: Arc<dyn ClaudeHandlers>,
    options: ClientOptions,
    exit_info: Mutex<Option<ExitInfo>>,
    closed: AtomicBool,
    counter: AtomicU64,
    stderr_tail: Mutex<VecDeque<String>>,
    pending: Mutex<HashMap<String, Reply>>,
    inbound: Mutex<HashMap<String, AbortHandle>>,
    writer: Mutex<Option<mpsc::UnboundedSender<String>>>,
    signal: Box<dyn Fn(KillSignal) + Send + Sync>,
    exited: watch::Receiver<bool>,
    tasks: Mutex<Vec<AbortHandle>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        for task in self.tasks.get_mut().drain(..) {
            task.abort();
        }
        for (_, task) in self.inbound.get_mut().drain() {
            task.abort();
        }
        if self.exit_info.get_mut().is_none() {
            (self.signal)(KillSignal::Kill);
        }
    }
}

/// A stream-json connection to one `claude` process. Cloning shares it; the process is killed
/// when the last clone is dropped.
#[derive(Clone)]
pub struct ClaudeClient {
    inner: Arc<Inner>,
}

async fn read_lines(stream: impl AsyncRead + Unpin, mut on_line: impl FnMut(String)) {
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if buffer.last() == Some(&b'\n') {
            buffer.pop();
        }
        on_line(String::from_utf8_lossy(&buffer).into_owned());
    }
}

impl ClaudeClient {
    /// Wires up a child; must be called inside a tokio runtime.
    pub fn new(child: ClaudeChild, handlers: Arc<dyn ClaudeHandlers>) -> Self {
        Self::with_options(child, handlers, ClientOptions::default())
    }

    pub fn with_options(
        child: ClaudeChild,
        handlers: Arc<dyn ClaudeHandlers>,
        options: ClientOptions,
    ) -> Self {
        let ClaudeChild { mut stdin, stdout, stderr, exit, signal } = child;
        let (exited_tx, exited) = watch::channel(false);
        let (writer, mut lines) = mpsc::unbounded_channel::<String>();
        let inner = Arc::new(Inner {
            handlers,
            options,
            exit_info: Mutex::new(None),
            closed: AtomicBool::new(false),
            counter: AtomicU64::new(0),
            stderr_tail: Mutex::new(VecDeque::new()),
            pending: Mutex::new(HashMap::new()),
            inbound: Mutex::new(HashMap::new()),
            writer: Mutex::new(Some(writer)),
            signal,
            exited,
            tasks: Mutex::new(Vec::new()),
        });
        let client = Self { inner: inner.clone() };
        let write_task = tokio::spawn(async move {
            while let Some(line) = lines.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
            let _ = stdin.shutdown().await;
        });
        let weak = Arc::downgrade(&inner);
        let stderr_task = tokio::spawn(read_lines(stderr, move |line| {
            if let Some(inner) = weak.upgrade() {
                let mut tail = inner.stderr_tail.lock();
                tail.push_back(line);
                while tail.len() > STDERR_TAIL_LINES {
                    tail.pop_front();
                }
            }
        }));
        let weak = Arc::downgrade(&inner);
        let (stdout_done_tx, stdout_done) = oneshot::channel::<()>();
        let read_task = tokio::spawn(async move {
            read_lines(stdout, |line| {
                if let Some(inner) = weak.upgrade() {
                    ClaudeClient { inner }.on_line(&line);
                }
            })
            .await;
            let _ = stdout_done_tx.send(());
        });
        let weak = Arc::downgrade(&inner);
        let exit_task = tokio::spawn(async move {
            let status = exit.await;
            let _ = tokio::time::timeout(STDOUT_DRAIN_AFTER_EXIT, stdout_done).await;
            if let Some(inner) = weak.upgrade() {
                ClaudeClient { inner }.on_exited(status);
            }
            let _ = exited_tx.send(true);
        });
        inner.tasks.lock().extend([
            write_task.abort_handle(),
            stderr_task.abort_handle(),
            read_task.abort_handle(),
            exit_task.abort_handle(),
        ]);
        client
    }

    pub fn is_exited(&self) -> bool {
        self.inner.exit_info.lock().is_some()
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.inner.exit_info.lock().clone()
    }

    pub fn stderr_tail(&self) -> String {
        self.inner.stderr_tail.lock().iter().cloned().collect::<Vec<_>>().join("\n")
    }

    fn write_value(&self, value: &Value) -> bool {
        let mut line = value.to_string();
        line.push('\n');
        match self.inner.writer.lock().as_ref() {
            Some(writer) => writer.send(line).is_ok(),
            None => false,
        }
    }

    fn next_request_id(&self) -> String {
        let count = self.inner.counter.fetch_add(1, Ordering::Relaxed);
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(count);
        let mut value = hasher.finish();
        let mut id = String::new();
        for _ in 0..11 {
            id.push(char::from_digit((value % 36) as u32, 36).unwrap_or('0'));
            value /= 36;
        }
        id
    }

    /// Writes `{"type":"user","message":{"role":"user","content":...},"session_id","uuid","parent_tool_use_id":null}`.
    pub fn send_user_message(
        &self,
        content: Value,
        session_id: &str,
        uuid: &str,
    ) -> Result<(), ClaudeError> {
        self.send_user_line(json!({
            "type": "user",
            "message": {"role": "user", "content": content},
            "session_id": session_id,
            "uuid": uuid,
            "parent_tool_use_id": null,
        }))
    }

    /// Writes a prepared `user` line (for optional fields such as `priority`).
    pub fn send_user_line(&self, line: Value) -> Result<(), ClaudeError> {
        if let Some(info) = self.exit_info() {
            return Err(ClaudeError::Exited(info.message()));
        }
        if self.write_value(&line) { Ok(()) } else { Err(ClaudeError::Closed) }
    }

    /// Writes `{"request_id","type":"control_request","request":{"subtype",...fields}}` now and
    /// returns the pending answer, which fails after the request timeout counted from now.
    pub fn control_request(&self, subtype: &str, fields: Map<String, Value>) -> ControlResponse {
        let mut request = Map::new();
        request.insert("subtype".to_owned(), Value::String(subtype.to_owned()));
        request.extend(fields);
        let request_id = self.next_request_id();
        let (reply, receiver) = oneshot::channel();
        let early = if let Some(info) = self.exit_info() {
            Some(ClaudeError::Exited(info.message()))
        } else {
            self.inner.pending.lock().insert(request_id.clone(), reply);
            let line =
                json!({"request_id": request_id, "type": "control_request", "request": request});
            if self.write_value(&line) {
                None
            } else {
                self.inner.pending.lock().remove(&request_id);
                Some(ClaudeError::Closed)
            }
        };
        let deadline = tokio::time::Instant::now() + self.inner.options.request_timeout;
        let inner = Arc::downgrade(&self.inner);
        let subtype = subtype.to_owned();
        Box::pin(async move {
            if let Some(error) = early {
                return Err(error);
            }
            match tokio::time::timeout_at(deadline, receiver).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(ClaudeError::Closed),
                Err(_) => {
                    if let Some(inner) = inner.upgrade() {
                        inner.pending.lock().remove(&request_id);
                    }
                    Err(ClaudeError::Timeout(subtype))
                }
            }
        })
    }

    pub fn initialize(&self, params: InitializeParams) -> ControlResponse {
        match serde_json::to_value(params) {
            Ok(Value::Object(fields)) => self.control_request("initialize", fields),
            _ => self.control_request("initialize", Map::new()),
        }
    }

    pub fn interrupt(&self) -> ControlResponse {
        self.control_request("interrupt", Map::new())
    }

    /// `None` omits `model`, which selects the default model.
    pub fn set_model(&self, model: Option<&str>) -> ControlResponse {
        let mut fields = Map::new();
        if let Some(model) = model {
            fields.insert("model".to_owned(), Value::String(model.to_owned()));
        }
        self.control_request("set_model", fields)
    }

    pub fn set_permission_mode(&self, mode: &str) -> ControlResponse {
        let mut fields = Map::new();
        fields.insert("mode".to_owned(), Value::String(mode.to_owned()));
        self.control_request("set_permission_mode", fields)
    }

    pub fn apply_flag_settings(&self, settings: Value) -> ControlResponse {
        let mut fields = Map::new();
        fields.insert("settings".to_owned(), settings);
        self.control_request("apply_flag_settings", fields)
    }

    /// Releases the process: interrupt (bounded wait), end stdin, then SIGTERM after 2 s and
    /// SIGKILL 5 s later. `on_exit` is not called afterwards.
    pub async fn close(&self) {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return self.wait_exit().await;
        }
        if !self.is_exited() {
            let _ = tokio::time::timeout(CLOSE_INTERRUPT_TIMEOUT, self.interrupt()).await;
        }
        self.inner.writer.lock().take();
        if tokio::time::timeout(CLOSE_SIGTERM_AFTER, self.wait_exit()).await.is_ok() {
            return;
        }
        (self.inner.signal)(KillSignal::Term);
        if tokio::time::timeout(CLOSE_SIGKILL_AFTER, self.wait_exit()).await.is_ok() {
            return;
        }
        (self.inner.signal)(KillSignal::Kill);
        self.wait_exit().await;
    }

    /// Ends stdin without interrupting or waiting.
    pub fn end_input(&self) {
        self.inner.writer.lock().take();
    }

    pub async fn wait_exit(&self) {
        let mut exited = self.inner.exited.clone();
        let _ = exited.wait_for(|done| *done).await;
    }

    fn on_exited(&self, status: ChildExit) {
        let info = ExitInfo {
            code: status.code,
            signal: status.signal,
            error: status.error,
            stderr_tail: self.stderr_tail(),
        };
        *self.inner.exit_info.lock() = Some(info.clone());
        self.inner.writer.lock().take();
        let pending: Vec<Reply> =
            self.inner.pending.lock().drain().map(|(_, reply)| reply).collect();
        for reply in pending {
            let _ = reply.send(Err(ClaudeError::Exited(info.message())));
        }
        for (_, task) in self.inner.inbound.lock().drain() {
            task.abort();
        }
        if !self.inner.closed.load(Ordering::SeqCst) {
            self.inner.handlers.on_exit(info);
        }
    }

    fn on_line(&self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(Value::Object(mut message)) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match message.get("type").and_then(Value::as_str) {
            Some("control_response") => {
                let Some(Value::Object(mut response)) = message.remove("response") else {
                    return;
                };
                let Some(id) = response.get("request_id").and_then(Value::as_str) else {
                    return;
                };
                let Some(reply) = self.inner.pending.lock().remove(id) else {
                    return;
                };
                let result = if response.get("subtype").and_then(Value::as_str) == Some("error") {
                    let error = response.get("error").and_then(Value::as_str).unwrap_or_default();
                    Err(ClaudeError::Response(error.to_owned()))
                } else {
                    Ok(response.remove("response").unwrap_or_else(|| json!({})))
                };
                let _ = reply.send(result);
            }
            Some("control_request") => {
                let id = message.get("request_id").and_then(Value::as_str).map(str::to_owned);
                let request = message.remove("request").unwrap_or(Value::Null);
                if let Some(id) = id {
                    self.on_control_request(id, request);
                }
            }
            Some("control_cancel_request") => {
                let id = message.get("request_id").and_then(Value::as_str);
                if let Some(task) = id.and_then(|id| self.inner.inbound.lock().remove(id)) {
                    task.abort();
                }
            }
            Some("keep_alive") => {}
            _ => self.inner.handlers.on_message(Value::Object(message)),
        }
    }

    fn on_control_request(&self, request_id: String, request: Value) {
        let client = self.clone();
        let id = request_id.clone();
        let mut inbound = self.inner.inbound.lock();
        let task = tokio::spawn(async move {
            let result = client.answer(request).await;
            if client.inner.inbound.lock().remove(&id).is_none() {
                return;
            }
            let response = match result {
                Ok(response) => {
                    json!({"subtype": "success", "request_id": id, "response": response})
                }
                Err(error) => json!({"subtype": "error", "request_id": id, "error": error}),
            };
            client.write_value(&json!({"type": "control_response", "response": response}));
        });
        inbound.insert(request_id, task.abort_handle());
    }

    async fn answer(&self, request: Value) -> Result<Value, String> {
        let text = |key: &str| request.get(key).and_then(Value::as_str).map(str::to_owned);
        let subtype = text("subtype").unwrap_or_default();
        match subtype.as_str() {
            "can_use_tool" => {
                let mut parsed: CanUseToolRequest =
                    serde_json::from_value(request.clone()).map_err(|error| error.to_string())?;
                parsed.raw = request.clone();
                Ok(self.inner.handlers.can_use_tool_response(parsed).await)
            }
            "hook_callback" => {
                let callback_id = text("callback_id").unwrap_or_default();
                let input = request.get("input").cloned().unwrap_or(Value::Null);
                self.inner.handlers.hook_callback(callback_id, input, text("tool_use_id")).await
            }
            "mcp_message" => {
                let name = text("server_name").unwrap_or_default();
                let server =
                    self.inner.options.mcp_servers.iter().find(|server| server.name() == name);
                let Some(server) = server.cloned() else {
                    return Err(format!("SDK MCP server not found: {name}"));
                };
                let message = request.get("message").cloned().unwrap_or(Value::Null);
                Ok(json!({"mcp_response": server.handle(message).await}))
            }
            _ => Err(format!("Unsupported control request subtype: {subtype}")),
        }
    }
}
