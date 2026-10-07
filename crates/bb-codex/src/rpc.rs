use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use bb_core::env::EnvMap;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::AbortHandle;

pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(60_000);
const STDERR_TAIL_LINES: usize = 40;
const EXIT_LINGER: Duration = Duration::from_millis(1_000);
const TERM_AFTER: Duration = Duration::from_millis(1_000);
const KILL_AFTER: Duration = Duration::from_millis(4_000);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KillSignal {
    Term,
    Kill,
}

/// How the child ended; `error` is set when it could not be spawned at all.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChildExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub error: Option<String>,
}

/// The process seam: real children come from `spawn_app_server`, tests script their own.
pub struct AppServerChild {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub stderr: Box<dyn AsyncRead + Send + Unpin>,
    pub exit: BoxFuture<'static, ChildExit>,
    pub signal: Box<dyn Fn(KillSignal) + Send + Sync>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub cwd: String,
    pub env: EnvMap,
}

pub type SpawnAppServer = Arc<dyn Fn(&str, &[String], Launch) -> AppServerChild + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(serde_json::Number),
    Text(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExitInfo {
    pub message: String,
    pub stderr_tail: String,
}

pub trait RpcHandlers: Send + Sync {
    fn on_notification(&self, method: &str, params: Value);
    fn on_request(&self, rpc: &CodexRpc, id: RequestId, method: &str, params: Value);
    fn on_exit(&self, info: ExitInfo);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcError {
    pub message: String,
    pub code: Option<i64>,
    pub spawn_failed: bool,
}

impl RpcError {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None, spawn_failed: false }
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RpcError {}

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

fn spawn_error(command: &str, error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => format!("spawn {command} ENOENT"),
        std::io::ErrorKind::PermissionDenied => format!("spawn {command} EACCES"),
        _ => format!("spawn {command} {error}"),
    }
}

fn failed_child(message: String) -> AppServerChild {
    AppServerChild {
        stdin: Box::new(tokio::io::sink()),
        stdout: Box::new(tokio::io::empty()),
        stderr: Box::new(tokio::io::empty()),
        exit: Box::pin(async move { ChildExit { code: None, signal: None, error: Some(message) } }),
        signal: Box::new(|_| {}),
    }
}

/// Spawns `command args` with exactly `launch.env`, piped stdio and `kill_on_drop`.
pub fn spawn_app_server(command: &str, args: &[String], launch: Launch) -> AppServerChild {
    let mut builder = tokio::process::Command::new(command);
    builder.args(args).current_dir(&launch.cwd).env_clear().envs(&launch.env).kill_on_drop(true);
    builder.stdin(std::process::Stdio::piped());
    builder.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = match builder.spawn() {
        Ok(child) => child,
        Err(error) => return failed_child(spawn_error(command, &error)),
    };
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return failed_child(format!("spawn {command} EPIPE"));
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
    AppServerChild {
        stdin: Box::new(stdin),
        stdout: Box::new(stdout),
        stderr: Box::new(stderr),
        exit,
        signal: Box::new(move |signal| {
            let _ = signals.send(signal);
        }),
    }
}

type Reply = oneshot::Sender<Result<Value, RpcError>>;

struct Inner {
    handlers: Arc<dyn RpcHandlers>,
    exited: AtomicBool,
    killing: AtomicBool,
    spawn_failed: AtomicBool,
    writable: Arc<AtomicBool>,
    next_id: AtomicU64,
    stderr_tail: Mutex<VecDeque<String>>,
    pending: Mutex<HashMap<u64, Reply>>,
    writer: Mutex<Option<mpsc::UnboundedSender<String>>>,
    signal: Arc<dyn Fn(KillSignal) + Send + Sync>,
    closed: watch::Receiver<bool>,
    tasks: Mutex<Vec<AbortHandle>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        for task in self.tasks.get_mut().drain(..) {
            task.abort();
        }
    }
}

/// One JSON-RPC connection to a `codex app-server` child. Cloning shares the connection; the
/// child is killed when the last clone is dropped.
#[derive(Clone)]
pub struct CodexRpc {
    inner: Arc<Inner>,
}

struct Incoming {
    id: Option<RequestId>,
    method: Option<String>,
    params: Value,
    result: Value,
    error: Option<(Option<i64>, Option<String>)>,
}

fn parse_message(line: &str) -> Option<Incoming> {
    let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(line) else {
        return None;
    };
    let id = match object.remove("id") {
        None => None,
        Some(Value::Number(number)) => Some(RequestId::Number(number)),
        Some(Value::String(text)) => Some(RequestId::Text(text)),
        Some(_) => return None,
    };
    let method = match object.remove("method") {
        None => None,
        Some(Value::String(text)) => Some(text),
        Some(_) => return None,
    };
    let error = match object.remove("error") {
        None => None,
        Some(Value::Object(error)) => {
            let code = match error.get("code") {
                None => None,
                Some(Value::Number(code)) => Some(code.as_i64().unwrap_or_default()),
                Some(_) => return None,
            };
            let message = match error.get("message") {
                None => None,
                Some(Value::String(message)) => Some(message.clone()),
                Some(_) => return None,
            };
            Some((code, message))
        }
        Some(_) => return None,
    };
    let params = object.remove("params").unwrap_or(Value::Null);
    let result = object.remove("result").unwrap_or(Value::Null);
    Some(Incoming { id, method, params, result, error })
}

fn pending_key(id: &RequestId) -> Option<u64> {
    match id {
        RequestId::Number(number) => number.as_u64(),
        RequestId::Text(text) => text.trim().parse().ok(),
    }
}

async fn read_lines(stream: impl AsyncRead + Unpin, mut on_line: impl FnMut(String) -> bool) {
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if buffer.last() != Some(&b'\n') {
            return;
        }
        buffer.pop();
        if !on_line(String::from_utf8_lossy(&buffer).into_owned()) {
            return;
        }
    }
}

impl CodexRpc {
    /// Wires up a child; must be called inside a tokio runtime.
    pub fn new(child: AppServerChild, handlers: Arc<dyn RpcHandlers>) -> Self {
        let AppServerChild { mut stdin, stdout, stderr, exit, signal } = child;
        let signal: Arc<dyn Fn(KillSignal) + Send + Sync> = Arc::from(signal);
        let (closed_tx, closed) = watch::channel(false);
        let (writer, mut lines) = mpsc::unbounded_channel::<String>();
        let writable = Arc::new(AtomicBool::new(true));
        let inner = Arc::new(Inner {
            handlers,
            exited: AtomicBool::new(false),
            killing: AtomicBool::new(false),
            spawn_failed: AtomicBool::new(false),
            writable: writable.clone(),
            next_id: AtomicU64::new(1),
            stderr_tail: Mutex::new(VecDeque::new()),
            pending: Mutex::new(HashMap::new()),
            writer: Mutex::new(Some(writer)),
            signal: signal.clone(),
            closed,
            tasks: Mutex::new(Vec::new()),
        });
        let write_task = tokio::spawn(async move {
            while let Some(line) = lines.recv().await {
                let written = stdin.write_all(line.as_bytes()).await;
                if written.is_err() || stdin.flush().await.is_err() {
                    writable.store(false, Ordering::SeqCst);
                    signal(KillSignal::Kill);
                    return;
                }
            }
            writable.store(false, Ordering::SeqCst);
            let _ = stdin.shutdown().await;
        });
        let (stdout_done_tx, stdout_done) = oneshot::channel::<()>();
        let weak = Arc::downgrade(&inner);
        let stdout_task = tokio::spawn(async move {
            read_lines(stdout, |line| match weak.upgrade() {
                Some(inner) => {
                    CodexRpc { inner }.receive(&line);
                    true
                }
                None => false,
            })
            .await;
            let _ = stdout_done_tx.send(());
        });
        let (stderr_done_tx, stderr_done) = oneshot::channel::<()>();
        let weak = Arc::downgrade(&inner);
        let stderr_task = tokio::spawn(async move {
            read_lines(stderr, |line| match weak.upgrade() {
                Some(inner) => {
                    let mut tail = inner.stderr_tail.lock();
                    tail.push_back(line);
                    while tail.len() > STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    true
                }
                None => false,
            })
            .await;
            let _ = stderr_done_tx.send(());
        });
        let weak = Arc::downgrade(&inner);
        let exit_task = tokio::spawn(async move {
            let status = exit.await;
            if status.error.is_none() {
                let streams = async {
                    let _ = stdout_done.await;
                    let _ = stderr_done.await;
                };
                let _ = tokio::time::timeout(EXIT_LINGER, streams).await;
            }
            if let Some(inner) = weak.upgrade() {
                let rpc = CodexRpc { inner };
                if let Some(error) = status.error.clone() {
                    rpc.inner.spawn_failed.store(true, Ordering::SeqCst);
                    rpc.inner.stderr_tail.lock().push_back(error);
                }
                if !rpc.inner.exited.load(Ordering::SeqCst) {
                    rpc.finalize(&status);
                }
            }
            let _ = closed_tx.send(true);
        });
        inner.tasks.lock().extend([
            write_task.abort_handle(),
            stdout_task.abort_handle(),
            stderr_task.abort_handle(),
            exit_task.abort_handle(),
        ]);
        Self { inner }
    }

    pub fn exited(&self) -> bool {
        self.inner.exited.load(Ordering::SeqCst)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT).await
    }

    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let inner = &self.inner;
        if inner.exited.load(Ordering::SeqCst) || inner.killing.load(Ordering::SeqCst) {
            let mut error = RpcError::new("codex app-server is not running");
            error.spawn_failed = inner.spawn_failed.load(Ordering::SeqCst);
            return Err(error);
        }
        let id = inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply, answer) = oneshot::channel();
        inner.pending.lock().insert(id, reply);
        self.write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        match tokio::time::timeout(timeout, answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::new("codex app-server is not running")),
            Err(_) => {
                inner.pending.lock().remove(&id);
                Err(RpcError::new(format!("codex app-server did not answer {method} in time")))
            }
        }
    }

    pub fn respond(&self, id: &RequestId, result: Value) {
        self.write(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    pub fn reject(&self, id: &RequestId, code: i64, message: &str) {
        let error = json!({"code": code, "message": message});
        self.write(&json!({"jsonrpc": "2.0", "id": id, "error": error}));
    }

    /// Closes stdin, escalates to SIGTERM after 1s and SIGKILL after 4s, and resolves once the
    /// child has exited. `on_exit` is not called for a kill.
    pub async fn kill(&self) {
        let inner = &self.inner;
        let already = inner.killing.swap(true, Ordering::SeqCst);
        if !already && !inner.exited.load(Ordering::SeqCst) {
            let weak: Weak<Inner> = Arc::downgrade(inner);
            let signal = inner.signal.clone();
            let escalate = tokio::spawn(async move {
                let running = |weak: &Weak<Inner>| {
                    weak.upgrade().is_some_and(|inner| !inner.exited.load(Ordering::SeqCst))
                };
                tokio::time::sleep(TERM_AFTER).await;
                if running(&weak) {
                    signal(KillSignal::Term);
                }
                tokio::time::sleep(KILL_AFTER - TERM_AFTER).await;
                if running(&weak) {
                    signal(KillSignal::Kill);
                }
            });
            inner.tasks.lock().push(escalate.abort_handle());
            inner.writer.lock().take();
        }
        let mut closed = inner.closed.clone();
        let _ = closed.wait_for(|closed| *closed).await;
    }

    fn write(&self, message: &Value) {
        let inner = &self.inner;
        let stopped = inner.exited.load(Ordering::SeqCst) || inner.killing.load(Ordering::SeqCst);
        if stopped || !inner.writable.load(Ordering::SeqCst) {
            return;
        }
        if let Some(writer) = inner.writer.lock().as_ref() {
            let _ = writer.send(format!("{message}\n"));
        }
    }

    fn receive(&self, line: &str) {
        let Some(message) = parse_message(line) else { return };
        if self.exited() {
            return;
        }
        let handlers = self.inner.handlers.clone();
        match (message.method, message.id) {
            (Some(method), Some(id)) => handlers.on_request(self, id, &method, message.params),
            (Some(method), None) => handlers.on_notification(&method, message.params),
            (None, Some(id)) => {
                let Some(key) = pending_key(&id) else { return };
                let Some(reply) = self.inner.pending.lock().remove(&key) else { return };
                let outcome = match message.error {
                    Some((code, text)) => {
                        let text =
                            text.unwrap_or_else(|| "codex app-server returned an error".into());
                        Err(RpcError { message: text, code, spawn_failed: false })
                    }
                    None => Ok(message.result),
                };
                let _ = reply.send(outcome);
            }
            (None, None) => {}
        }
    }

    fn finalize(&self, status: &ChildExit) {
        let inner = &self.inner;
        inner.exited.store(true, Ordering::SeqCst);
        let stderr_tail = inner.stderr_tail.lock().iter().cloned().collect::<Vec<_>>().join("\n");
        let code = status.code.map_or_else(|| "null".to_owned(), |code| code.to_string());
        let signal = status.signal.clone().unwrap_or_else(|| "null".to_owned());
        let suffix =
            if stderr_tail.is_empty() { String::new() } else { format!(": {stderr_tail}") };
        let message = format!("codex app-server exited (code {code}, signal {signal}){suffix}");
        let spawn_failed = inner.spawn_failed.load(Ordering::SeqCst);
        let pending: Vec<Reply> = inner.pending.lock().drain().map(|(_, reply)| reply).collect();
        for reply in pending {
            let error = RpcError { message: message.clone(), code: None, spawn_failed };
            let _ = reply.send(Err(error));
        }
        if !inner.killing.load(Ordering::SeqCst) {
            inner.handlers.on_exit(ExitInfo { message, stderr_tail });
        }
    }
}

#[cfg(test)]
#[path = "rpc_tests.rs"]
mod tests;
