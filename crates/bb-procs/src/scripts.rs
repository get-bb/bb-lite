use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bb_core::env::EnvMap;
use bb_core::exec::{Ctx, path_exists, require_absolute};
use bb_core::{RunnerError, RunnerErrorCode, RunnerEvent, RunnerEventBody, RunnerResult, fail};
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::lines::{LineReader, Utf8Decoder};
use crate::signal_group;

pub const DEFAULT_ENV_SETUP_SCRIPT_NAME: &str = ".bb-env-setup.sh";
pub const DEFAULT_ENV_TEARDOWN_SCRIPT_NAME: &str = ".bb-env-teardown.sh";

const REMEMBERED_OPERATIONS: usize = 256;
const MAX_TIMER_MS: u64 = (1 << 31) - 1;
const OUTPUT_DRAIN_MS: u64 = 250;
const OUTPUT_EVENT_MAX_LENGTH: usize = 64 * 1024;
const GROUP_EXIT_POLL_MS: u64 = 25;
const GROUP_EXIT_POLLS: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptKind {
    Setup,
    Teardown,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLifecycleScriptArgs {
    pub operation_id: String,
    pub path: String,
    pub kind: ScriptKind,
    pub timeout_ms: u64,
    pub env: EnvMap,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FailureReason {
    Exit,
    Signal,
    Timeout,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptFailure {
    pub reason: FailureReason,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleScriptResult {
    pub ran: bool,
    pub exit_code: Option<i32>,
    pub failure: Option<ScriptFailure>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelOperationArgs {
    pub operation_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelOperationResult {
    pub cancelled: bool,
}

type Done = Shared<BoxFuture<'static, RunnerResult<LifecycleScriptResult>>>;

struct Operation {
    token: CancellationToken,
    done: Done,
    settled: Arc<AtomicBool>,
}

#[derive(Clone)]
enum Entry {
    Cancelled,
    Running(Arc<Operation>),
}

/// Runs `.bb-env-setup.sh` / `.bb-env-teardown.sh` and cancels them by operation id.
#[derive(Clone)]
pub struct LifecycleScripts {
    ctx: Ctx,
    operations: Arc<Mutex<IndexMap<String, Entry>>>,
}

fn failed(reason: FailureReason, message: String, exit_code: Option<i32>) -> LifecycleScriptResult {
    LifecycleScriptResult { ran: true, exit_code, failure: Some(ScriptFailure { reason, message }) }
}

fn emit(ctx: &Ctx, operation_id: &str, lines: Vec<String>) {
    let output: String = lines.into_iter().map(|line| line + "\n").collect();
    let chars: Vec<char> = output.chars().collect();
    for piece in chars.chunks(OUTPUT_EVENT_MAX_LENGTH) {
        let text: String = piece.iter().collect();
        let operation_id = operation_id.to_owned();
        (ctx.sink)(RunnerEvent::unsequenced(RunnerEventBody::ScriptOutput { operation_id, text }));
    }
}

fn stream_lines(
    ctx: &Ctx,
    operation_id: &str,
    stream: Option<impl AsyncRead + Unpin + Send + 'static>,
) -> (JoinHandle<()>, Arc<Mutex<LineReader>>) {
    let reader = Arc::new(Mutex::new(LineReader::default()));
    let (ctx, operation_id, lines) = (ctx.clone(), operation_id.to_owned(), reader.clone());
    let task = tokio::spawn(async move {
        let Some(mut stream) = stream else { return };
        let mut decoder = Utf8Decoder::default();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let text = decoder.push(&buffer[..read]);
                    let complete = lines.lock().push(&text);
                    emit(&ctx, &operation_id, complete);
                }
            }
        }
        let rest = decoder.finish();
        let complete = lines.lock().push(&rest);
        emit(&ctx, &operation_id, complete);
    });
    (task, reader)
}

fn signal_name(signal: i32) -> String {
    const NAMES: [&str; 31] = [
        "SIGHUP",
        "SIGINT",
        "SIGQUIT",
        "SIGILL",
        "SIGTRAP",
        "SIGABRT",
        "SIGBUS",
        "SIGFPE",
        "SIGKILL",
        "SIGUSR1",
        "SIGSEGV",
        "SIGUSR2",
        "SIGPIPE",
        "SIGALRM",
        "SIGTERM",
        "SIGSTKFLT",
        "SIGCHLD",
        "SIGCONT",
        "SIGSTOP",
        "SIGTSTP",
        "SIGTTIN",
        "SIGTTOU",
        "SIGURG",
        "SIGXCPU",
        "SIGXFSZ",
        "SIGVTALRM",
        "SIGPROF",
        "SIGWINCH",
        "SIGIO",
        "SIGPWR",
        "SIGSYS",
    ];
    let named = match signal {
        libc::SIGHUP => Some("SIGHUP"),
        libc::SIGINT => Some("SIGINT"),
        libc::SIGQUIT => Some("SIGQUIT"),
        libc::SIGABRT => Some("SIGABRT"),
        libc::SIGKILL => Some("SIGKILL"),
        libc::SIGSEGV => Some("SIGSEGV"),
        libc::SIGPIPE => Some("SIGPIPE"),
        libc::SIGTERM => Some("SIGTERM"),
        _ if cfg!(target_os = "linux") => {
            usize::try_from(signal - 1).ok().and_then(|index| NAMES.get(index).copied())
        }
        _ => None,
    };
    named.map_or_else(|| signal.to_string(), str::to_owned)
}

fn exit_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

async fn run_script(
    ctx: Ctx,
    args: RunLifecycleScriptArgs,
    token: CancellationToken,
) -> RunnerResult<LifecycleScriptResult> {
    let setup = args.kind == ScriptKind::Setup;
    let script_name =
        if setup { DEFAULT_ENV_SETUP_SCRIPT_NAME } else { DEFAULT_ENV_TEARDOWN_SCRIPT_NAME };
    let script_path = Path::new(require_absolute(&args.path, "Path")?).join(script_name);
    if !path_exists(&script_path).await {
        return Ok(LifecycleScriptResult { ran: false, exit_code: None, failure: None });
    }
    if cfg!(windows) {
        return fail(RunnerErrorCode::Unavailable, format!("{script_name} needs a POSIX shell"));
    }
    let mut env = (ctx.env)().await;
    env.extend(args.env.clone());
    let mut child = Command::new("env")
        .arg("bash")
        .arg(&script_path)
        .current_dir(&args.path)
        .process_group(0)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let pid = child.id();
    let kill_group = || signal_group(pid, libc::SIGKILL);
    let (mut out_task, out_lines) = stream_lines(&ctx, &args.operation_id, child.stdout.take());
    let (mut err_task, err_lines) = stream_lines(&ctx, &args.operation_id, child.stderr.take());
    let timer = tokio::time::sleep(Duration::from_millis(args.timeout_ms.min(MAX_TIMER_MS)));
    tokio::pin!(timer);
    let (mut timed_out, mut aborted) = (false, false);
    let status = loop {
        tokio::select! {
            status = child.wait() => break status?,
            () = &mut timer, if !timed_out => {
                timed_out = true;
                kill_group();
            }
            () = token.cancelled(), if !aborted => {
                aborted = true;
                kill_group();
            }
        }
    };
    let closed = async {
        let _ = (&mut out_task).await;
        let _ = (&mut err_task).await;
    };
    let _ = tokio::time::timeout(Duration::from_millis(OUTPUT_DRAIN_MS), closed).await;
    let cancelled = token.is_cancelled();
    if timed_out || cancelled {
        for _ in 0..GROUP_EXIT_POLLS {
            if !signal_group(pid, 0) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(GROUP_EXIT_POLL_MS)).await;
        }
    }
    out_task.abort();
    err_task.abort();
    for lines in [out_lines, err_lines] {
        let rest = lines.lock().flush();
        emit(&ctx, &args.operation_id, rest);
    }
    let label = format!("{} script", if setup { "Setup" } else { "Teardown" });
    let shown = script_path.display();
    let report =
        |reason, how: String, code| failed(reason, format!("{label} {how}: {shown}"), code);
    if cancelled {
        return Ok(failed(FailureReason::Cancelled, format!("{script_name} cancelled"), None));
    }
    if timed_out {
        let how = format!("timed out after {}ms", args.timeout_ms);
        return Ok(report(FailureReason::Timeout, how, None));
    }
    if let Some(signal) = exit_signal(&status) {
        let how = format!("exited via signal {}", signal_name(signal));
        return Ok(report(FailureReason::Signal, how, None));
    }
    let code = status.code().unwrap_or(1);
    if code != 0 {
        let how = format!("failed with exit code {code}");
        return Ok(report(FailureReason::Exit, how, Some(code)));
    }
    Ok(LifecycleScriptResult { ran: true, exit_code: Some(0), failure: None })
}

impl LifecycleScripts {
    pub fn new(ctx: Ctx) -> Self {
        Self { ctx, operations: Arc::default() }
    }

    pub async fn run(&self, args: RunLifecycleScriptArgs) -> RunnerResult<LifecycleScriptResult> {
        let done = {
            let mut operations = self.operations.lock();
            match operations.get(&args.operation_id) {
                Some(Entry::Cancelled) => {
                    let reason = "Operation was cancelled before it started".to_owned();
                    let result = failed(FailureReason::Cancelled, reason, None);
                    return Ok(LifecycleScriptResult { ran: false, ..result });
                }
                Some(Entry::Running(operation)) => operation.done.clone(),
                None => {
                    let token = CancellationToken::new();
                    let settled = Arc::new(AtomicBool::new(false));
                    let operation_id = args.operation_id.clone();
                    let work = run_script(self.ctx.clone(), args, token.clone());
                    let mark = settled.clone();
                    let task = tokio::spawn(async move {
                        let result = work.await;
                        mark.store(true, Ordering::SeqCst);
                        result
                    });
                    let done = async move {
                        task.await
                            .unwrap_or_else(|error| Err(RunnerError::failed(error.to_string())))
                    }
                    .boxed()
                    .shared();
                    let operation = Operation { token, done: done.clone(), settled };
                    operations.insert(operation_id, Entry::Running(Arc::new(operation)));
                    if operations.len() > REMEMBERED_OPERATIONS {
                        operations.shift_remove_index(0);
                    }
                    done
                }
            }
        };
        done.await
    }

    pub async fn cancel(&self, args: CancelOperationArgs) -> RunnerResult<CancelOperationResult> {
        let operation = {
            let mut operations = self.operations.lock();
            match operations.get(&args.operation_id) {
                Some(Entry::Running(operation)) => operation.clone(),
                _ => {
                    operations.insert(args.operation_id, Entry::Cancelled);
                    return Ok(CancelOperationResult { cancelled: false });
                }
            }
        };
        let cancelled = !operation.settled.load(Ordering::SeqCst);
        operation.token.cancel();
        let _ = operation.done.clone().await;
        Ok(CancelOperationResult { cancelled })
    }

    pub async fn dispose(&self) {
        let running: Vec<Arc<Operation>> = self
            .operations
            .lock()
            .values()
            .filter_map(|entry| match entry {
                Entry::Running(operation) => Some(operation.clone()),
                Entry::Cancelled => None,
            })
            .collect();
        running.iter().for_each(|operation| operation.token.cancel());
        futures::future::join_all(running.iter().map(|operation| operation.done.clone())).await;
    }
}
