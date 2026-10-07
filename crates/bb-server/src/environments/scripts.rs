//! Lifecycle scripts of managed workspaces. The port of
//! `apps/server/src/environments/scripts.ts`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use bb_core::{RunnerEventBody, SharedRunner};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::types::ProgressSink;
use crate::context::Ctx;
use crate::error::{ApiError, ApiResult};
use crate::machine_environment::resolve_contributed_environment;
use crate::runners::registry::RunnerEventHandler;

pub const SETUP_SCRIPT: &str = ".bb-env-setup.sh";
const SCRIPT_TIMEOUT_MS: i64 = 15 * 60_000;

type LineSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Who receives the output lines of each running script.
#[derive(Default)]
pub struct ScriptListeners {
    listeners: Arc<Mutex<HashMap<String, LineSink>>>,
    subscribed: AtomicBool,
}

#[derive(Clone, Debug)]
pub struct Workspace {
    pub id: String,
    pub host_id: String,
    pub project_id: String,
    pub path: String,
}

#[derive(Deserialize)]
struct ScriptFailure {
    message: String,
}

#[derive(Deserialize)]
struct LifecycleScriptResult {
    #[serde(default)]
    failure: Option<ScriptFailure>,
}

pub fn step(
    key: &str,
    text: &str,
    status: &str,
    started_at: i64,
    metadata: Option<Value>,
) -> Value {
    let mut entry = json!({
        "type": "step", "key": key, "text": text, "status": status, "startedAt": started_at,
    });
    if let (Some(metadata), Some(object)) = (metadata, entry.as_object_mut()) {
        object.insert("metadata".into(), metadata);
    }
    entry
}

pub fn not_ready(message: impl Into<String>) -> ApiError {
    ApiError::new(409, "environment_not_ready", message)
}

fn subscribe(ctx: &Ctx) {
    let scripts = &ctx.environments.scripts;
    if scripts.subscribed.swap(true, Ordering::SeqCst) {
        return;
    }
    let listeners = scripts.listeners.clone();
    let handler: RunnerEventHandler = Arc::new(move |event, _host_id| {
        if let RunnerEventBody::ScriptOutput { operation_id, text } = &event.body {
            let listener = listeners.lock().get(operation_id).cloned();
            if let Some(listener) = listener {
                let text = text.strip_suffix('\n').unwrap_or(text);
                text.split('\n').for_each(|line| listener(line));
            }
        }
        Box::pin(async { Ok(()) })
    });
    ctx.runners.on_event("script.output", handler).forever();
}

struct Listening<'a> {
    listeners: &'a Mutex<HashMap<String, LineSink>>,
    operation_id: String,
}

impl Drop for Listening<'_> {
    fn drop(&mut self) {
        self.listeners.lock().remove(&self.operation_id);
    }
}

fn cancel_operation(runner: &SharedRunner, operation_id: &str) {
    let (runner, params) = (runner.clone(), json!({ "operationId": operation_id }));
    tokio::spawn(async move {
        let _ = runner.call("cancelOperation", params).await;
    });
}

async fn run(
    ctx: &Ctx,
    workspace: &Workspace,
    kind: &str,
    on_line: LineSink,
    signal: Option<&CancellationToken>,
) -> ApiResult<LifecycleScriptResult> {
    subscribe(ctx);
    let runner = ctx.runners.get(&workspace.host_id)?;
    let operation_id = random_uuid();
    let listeners = &ctx.environments.scripts.listeners;
    listeners.lock().insert(operation_id.clone(), on_line);
    let _listening = Listening { listeners, operation_id: operation_id.clone() };
    let env = resolve_contributed_environment(ctx, Some(&workspace.project_id)).await?;
    let script = json!({
        "operationId": operation_id, "path": workspace.path, "kind": kind,
        "timeoutMs": SCRIPT_TIMEOUT_MS, "env": env,
    });
    let call = runner.call("runLifecycleScript", script);
    tokio::pin!(call);
    let result = match signal {
        None => call.await?,
        Some(signal) => tokio::select! {
            result = &mut call => result?,
            () = signal.cancelled() => {
                cancel_operation(&runner, &operation_id);
                call.await?
            }
        },
    };
    Ok(serde_json::from_value(result)?)
}

fn random_uuid() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

pub fn cancelled() -> ApiError {
    not_ready("Workspace setup was cancelled")
}

pub async fn setup(
    ctx: &Ctx,
    workspace: &Workspace,
    on_progress: &ProgressSink,
    signal: &CancellationToken,
) -> ApiResult<()> {
    let script = format!("{}/{SETUP_SCRIPT}", workspace.path);
    let runner = ctx.runners.get(&workspace.host_id)?;
    let found = runner.call("pathsExist", json!({ "paths": [script] })).await?;
    if found.pointer("/existence").and_then(|map| map.get(&script)) != Some(&Value::Bool(true)) {
        return Ok(());
    }
    let started_at = ctx.now();
    let running = format!("Running {SETUP_SCRIPT}");
    on_progress(vec![step("setup-started", &running, "started", started_at, None)]);
    let lines = Arc::new(Mutex::new(0_u64));
    let (progress, clock) = (on_progress.clone(), ctx.clone());
    let report: LineSink = Arc::new(move |text| {
        let count = {
            let mut lines = lines.lock();
            *lines += 1;
            *lines
        };
        let key = format!("setup-output-{count}");
        progress(vec![
            json!({"type": "output", "key": key, "text": text, "startedAt": clock.now()}),
        ]);
    });
    let result = run(ctx, workspace, "setup", report, Some(signal)).await?;
    if signal.is_cancelled() {
        return Err(cancelled());
    }
    let (status, outcome) = match result.failure {
        None => ("completed", "finished"),
        Some(_) => ("failed", "failed"),
    };
    let text = format!("{SETUP_SCRIPT} {outcome}");
    let metadata = json!({ "durationMs": ctx.now() - started_at });
    let key = format!("setup-{status}");
    on_progress(vec![step(&key, &text, status, started_at, Some(metadata))]);
    match result.failure {
        Some(failure) => Err(not_ready(failure.message)),
        None => Ok(()),
    }
}

pub async fn teardown(ctx: &Ctx, workspace: &Workspace) -> ApiResult<()> {
    let (log, environment_id) = (ctx.log.clone(), workspace.id.clone());
    let report: LineSink = Arc::new(move |text| {
        let fields = json!({ "environmentId": environment_id, "text": text });
        log.info("Environment teardown output", fields);
    });
    let result = run(ctx, workspace, "teardown", report, None).await?;
    if let Some(ScriptFailure { message }) = result.failure {
        let fields = json!({ "environmentId": workspace.id, "message": message });
        ctx.log.warn("Environment teardown script failed", fields);
    }
    Ok(())
}
