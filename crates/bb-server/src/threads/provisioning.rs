//! Workspace preparation before the first turn. Skeleton of
//! `apps/server/src/threads/provisioning.ts`.

use std::sync::Arc;
use std::time::Duration;

use bb_core::ids::new_id;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::core::{Outbox, Provisioning};
use super::dispatch::{self, DispatchArgs, OutboundMessage};
use super::engine::{self, ThreadFailure};
use super::execution::{ThreadTurnInitiator, to_runner_options};
use super::session_spec::{SessionEnvironment, build_session_spec};
use crate::context::Ctx;
use crate::db::environments::get_environment;
use crate::db::threads::{self as store, ThreadPatch, ThreadRow};
use crate::domain::changes::ThreadChangeKind;
use crate::domain::events::thread_scope;
use crate::domain::queued_message::QueuedMessageWaitingOn;
use crate::domain::thread::{ThreadLifecycleEventType, ThreadStatus};
use crate::environments::manager::ensure_for_thread;
use crate::environments::scripts::step;
use crate::environments::types::{
    EnsureEnvironmentArgs, EnvironmentIntent, ProgressSink, ThreadEnvironment,
};
use crate::error::{ApiError, ApiResult};

/// `startupContextSchema`, stored as JSON in `threads.startup_context`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupContext {
    /// `EnvironmentIntent`.
    pub intent: Value,
    pub title_provided: bool,
}

struct ProvisioningJob {
    id: String,
    request_id: String,
    startup: StartupContext,
    message: OutboundMessage,
}

const TITLE_FALLBACK_MAX_LENGTH: usize = 80;
const GENERATED_TITLE_MAX_LENGTH: usize = 48;
const TITLE_MIN_WORDS: usize = 5;
const TITLE_TIMEOUT: Duration = Duration::from_millis(5_000);
const WORKSPACE_PATH_STEP: &str = "workspace-path";
const WORKSPACE_BRANCH_STEP: &str = "workspace-branch";
const PROVISIONING_WAIT: &[Option<&str>] = &[Some("provisioning")];

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn prompt_text(input: &[Value]) -> String {
    let parts: Vec<&str> = input
        .iter()
        .filter(|part| part["type"] == "text")
        .map(|part| part["text"].as_str().unwrap_or_default().trim())
        .collect();
    collapse(&parts.join(" "))
}

fn truncate(text: &str, length: usize) -> String {
    text.chars().take(length).collect()
}

/// `input` is `PromptInput[]`.
pub fn derive_title_fallback(input: &[Value]) -> Option<String> {
    let text = prompt_text(input);
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= TITLE_FALLBACK_MAX_LENGTH {
        return Some(text);
    }
    Some(format!("{}...", truncate(&text, TITLE_FALLBACK_MAX_LENGTH - 3)))
}

fn title_prompt(input: &[Value]) -> Option<String> {
    derive_title_fallback(input).filter(|text| text.split(' ').count() >= TITLE_MIN_WORDS)
}

fn sanitize_title(generated: Option<String>) -> Option<String> {
    let title = collapse(generated.as_deref().unwrap_or_default());
    let title = truncate(&title, GENERATED_TITLE_MAX_LENGTH).trim().to_owned();
    (!title.is_empty()).then_some(title)
}

fn is_current(ctx: &Ctx, thread: &ThreadRow, job_id: &str) -> bool {
    let running = engine::runtime_of(ctx, &thread.id, |runtime| {
        runtime.provisioning.as_ref().map(|running| running.id == job_id)
    });
    thread.status == ThreadStatus::Starting && running == Some(true)
}

fn append_provisioning(
    ctx: &Ctx,
    out: &Outbox,
    thread: &ThreadRow,
    provisioning_id: &str,
    status: &str,
    entries: Vec<Value>,
) -> ApiResult<()> {
    let event = json!({
        "type": "system/thread-provisioning",
        "scope": thread_scope(),
        "provisioningId": provisioning_id,
        "status": status,
        "environmentId": thread.environment_id,
        "entries": entries,
    });
    engine::append(ctx, out, thread, &[event])
}

async fn generate_title(
    ctx: Ctx,
    thread_id: String,
    input: Vec<Value>,
    record: ProgressSink,
) -> ApiResult<()> {
    let started_at = ctx.now();
    record(vec![step("metadata-started", "Generating title", "started", started_at, None)]);
    let generated = match title_prompt(&input) {
        None => None,
        Some(prompt) => {
            let cancel = CancellationToken::new();
            let generating = ctx.plugins.generate_title(&prompt, cancel.clone());
            let generated = tokio::time::timeout(TITLE_TIMEOUT, generating).await;
            cancel.cancel();
            generated.ok().flatten()
        }
    };
    let title = sanitize_title(generated);
    let title_generated = title.is_some();
    let text = if title_generated { "Generated title" } else { "No title generated" };
    let metadata =
        json!({ "durationMs": ctx.now() - started_at, "titleGenerated": title_generated });
    record(vec![step("metadata-completed", text, "completed", started_at, Some(metadata))]);
    let Some(title) = title else { return Ok(()) };
    let task_ctx = ctx.clone();
    let id = thread_id.clone();
    engine::in_thread(&ctx, &thread_id, async move { engine::adopt_title(&task_ctx, &id, &title) })
        .await
}

fn initiator_of(message: &OutboundMessage) -> ApiResult<ThreadTurnInitiator> {
    Ok(serde_json::from_value(json!(message.initiator))?)
}

async fn complete_provisioning(
    ctx: &Ctx,
    thread_id: &str,
    job: &ProvisioningJob,
    environment: ThreadEnvironment,
) -> ApiResult<()> {
    let db = &ctx.db;
    let ThreadEnvironment { environment_id, path } = environment;
    let Some(thread) = store::get_thread(db, thread_id)? else { return Ok(()) };
    if thread.deleted_at.is_some() {
        return Ok(());
    }
    let current = is_current(ctx, &thread, &job.id);
    let Some(row) = get_environment(db, &environment_id)? else {
        return Err(ApiError::internal("Prepared environment is missing"));
    };
    let attached = engine::commit(ctx, |out| {
        let patch = ThreadPatch::new().set("environmentId", environment_id.clone());
        let next = store::patch_thread(db, thread_id, &patch, true)?;
        let metadata = super::create::project_metadata(&thread.project_id);
        out.thread(thread_id, vec![ThreadChangeKind::EnvironmentChanged], Some(metadata));
        if !current {
            return Ok(next);
        }
        let at = ctx.now();
        let workspace = format!("Using workspace: {path}");
        let mut entries = vec![step(WORKSPACE_PATH_STEP, &workspace, "completed", at, None)];
        if let Some(branch_name) = &row.branch_name {
            let text = format!("Using branch: {branch_name}");
            let metadata = Some(json!({ "branchName": branch_name }));
            entries.push(step(WORKSPACE_BRANCH_STEP, &text, "completed", at, metadata));
        }
        append_provisioning(ctx, out, &next, &job.id, "active", entries)?;
        Ok(next)
    })?;
    if !current {
        return Ok(());
    }
    let host = SessionEnvironment { id: environment_id, host_id: row.host_id.clone(), path };
    let session = build_session_spec(ctx, &attached, &host).await?;
    let initiator = initiator_of(&job.message)?;
    engine::commit(ctx, |out| {
        append_provisioning(ctx, out, &attached, &job.id, "completed", Vec::new())?;
        let starting = QueuedMessageWaitingOn::TurnStarting;
        engine::relabel_waits(ctx, out, thread_id, PROVISIONING_WAIT, Some(&starting))?;
        engine::transition(ctx, out, thread_id, ThreadLifecycleEventType::RunStarted)?;
        let execution = &job.message.execution;
        let options = to_runner_options(db, &attached.provider_id, execution, initiator)?;
        let turn = json!({
            "session": session,
            "clientRequestId": job.request_id,
            "input": job.message.input,
            "options": options,
            "mode": { "kind": "start" },
        });
        let (task_ctx, attached, host_id) = (ctx.clone(), attached.clone(), row.host_id.clone());
        out.after(move || {
            if let Err(error) = dispatch::submit_to_runner(&task_ctx, &attached, &host_id, turn) {
                let err = error.to_string();
                task_ctx.log.error("Thread follow-up failed", json!({ "err": err }));
            }
        });
        Ok(())
    })
}

fn fail_provisioning(
    ctx: &Ctx,
    thread_id: &str,
    job: &ProvisioningJob,
    error: &ApiError,
) -> ApiResult<()> {
    let Some(thread) = store::get_thread(&ctx.db, thread_id)? else { return Ok(()) };
    if !is_current(ctx, &thread, &job.id) {
        return Ok(());
    }
    let err = error.to_string();
    ctx.log.warn("Thread provisioning failed", json!({ "err": err, "threadId": thread_id }));
    engine::commit(ctx, |out| {
        if thread.environment_id.is_none() {
            let entries =
                vec![step("workspace-failed", "Workspace setup failed", "failed", ctx.now(), None)];
            append_provisioning(ctx, out, &thread, &job.id, "failed", entries)?;
        }
        engine::relabel_waits(ctx, out, thread_id, PROVISIONING_WAIT, None)?;
        let failure = ThreadFailure {
            code: "thread_provisioning_failed".to_owned(),
            message: "Provisioning thread failed".to_owned(),
            detail: err.clone(),
        };
        let context = "failed during workspace setup before a turn began";
        engine::fail_thread(ctx, out, &thread, &failure, Some(context))
    })
}

async fn prepare(
    ctx: &Ctx,
    thread_id: &str,
    job: &ProvisioningJob,
    abort: CancellationToken,
    record: ProgressSink,
) -> ApiResult<Option<ThreadEnvironment>> {
    let intent: EnvironmentIntent = serde_json::from_value(job.startup.intent.clone())?;
    record(vec![step("workspace-started", "Preparing workspace", "started", ctx.now(), None)]);
    let builds = !matches!(intent, EnvironmentIntent::Reuse { .. });
    if !job.startup.title_provided {
        let (input, id) = (job.message.input.clone(), thread_id.to_owned());
        let sink: ProgressSink = if builds { record.clone() } else { Arc::new(|_| {}) };
        let titled = generate_title(ctx.clone(), id, input, sink);
        if builds {
            titled.await?;
        } else {
            engine::background(ctx, "generate title", titled);
        }
    }
    let Some(thread) = store::get_thread(&ctx.db, thread_id)? else { return Ok(None) };
    let args = EnsureEnvironmentArgs { thread, intent, on_progress: record, signal: abort };
    ensure_for_thread(ctx, args).await.map(Some)
}

async fn run_provisioning(
    ctx: Ctx,
    thread_id: String,
    job: ProvisioningJob,
    abort: CancellationToken,
) -> ApiResult<()> {
    let job = Arc::new(job);
    let record: ProgressSink = {
        let (ctx, thread_id, job) = (ctx.clone(), thread_id.clone(), job.clone());
        Arc::new(move |entries: Vec<Value>| {
            let (task_ctx, id, job) = (ctx.clone(), thread_id.clone(), job.clone());
            engine::later(&ctx, &thread_id, "provisioning progress", async move {
                let Some(thread) = store::get_thread(&task_ctx.db, &id)? else { return Ok(()) };
                if !is_current(&task_ctx, &thread, &job.id) {
                    return Ok(());
                }
                engine::commit(&task_ctx, |out| {
                    append_provisioning(&task_ctx, out, &thread, &job.id, "active", entries)
                })
            });
        })
    };
    let prepared = prepare(&ctx, &thread_id, &job, abort, record).await;
    let (task_ctx, id, task_job) = (ctx.clone(), thread_id.clone(), job.clone());
    let settled = match prepared {
        Ok(None) => Ok(()),
        Ok(Some(environment)) => {
            engine::in_thread(&ctx, &thread_id, async move {
                complete_provisioning(&task_ctx, &id, &task_job, environment).await
            })
            .await
        }
        Err(error) => Err(error),
    };
    let settled = match settled {
        Err(error) => {
            let (task_ctx, id, task_job) = (ctx.clone(), thread_id.clone(), job.clone());
            engine::in_thread(&ctx, &thread_id, async move {
                fail_provisioning(&task_ctx, &id, &task_job, &error)
            })
            .await
        }
        Ok(()) => Ok(()),
    };
    engine::runtime_of(&ctx, &thread_id, |runtime| {
        if runtime.provisioning.as_ref().is_some_and(|running| running.id == job.id) {
            runtime.provisioning = None;
        }
    });
    settled
}

fn startup_of(thread: &ThreadRow) -> ApiResult<StartupContext> {
    if let Some(environment_id) = &thread.environment_id {
        let intent = EnvironmentIntent::Reuse { environment_id: environment_id.clone() };
        return Ok(StartupContext { intent: serde_json::to_value(intent)?, title_provided: true });
    }
    if let Some(startup) = &thread.startup_context {
        let startup: StartupContext = serde_json::from_str(startup)?;
        serde_json::from_value::<EnvironmentIntent>(startup.intent.clone())?;
        return Ok(startup);
    }
    let message = format!("Thread {} has no workspace to start in", thread.id);
    Err(ApiError::new(500, "internal_error", message))
}

pub fn begin_provisioning(ctx: &Ctx, thread: &ThreadRow, args: DispatchArgs) -> ApiResult<()> {
    let startup = startup_of(thread)?;
    let message = dispatch::attributed_message(&args.message);
    let request_id = new_id("creq");
    let job = ProvisioningJob { id: new_id("tpv"), request_id, startup, message };
    engine::commit(ctx, |out| {
        dispatch::consume_rows(ctx, out, thread, &args.rows)?;
        let restores = thread.environment_id.is_some();
        let kind = if restores { "new-turn" } else { "thread-start" };
        let message = &job.message;
        let mut events =
            vec![dispatch::turn_request_event(message, &job.request_id, json!({ "kind": kind }))];
        if !restores {
            events.push(json!({
                "type": "client/thread/start",
                "scope": thread_scope(),
                "direction": "outbound",
                "source": "spawn",
                "initiator": message.initiator,
                "request": { "method": "thread/start", "params": {} },
            }));
        }
        engine::append(ctx, out, thread, &events)?;
        let execution = &message.execution;
        let patch = ThreadPatch::new()
            .set("model", execution.model.clone())
            .set("reasoningLevel", execution.reasoning_level.as_str())
            .set("permissionMode", execution.permission_mode.as_str())
            .set("serviceTier", execution.service_tier.as_str());
        store::patch_thread(&ctx.db, &thread.id, &patch, false)?;
        engine::transition(ctx, out, &thread.id, ThreadLifecycleEventType::RunPreparing)?;
        Ok(())
    })?;
    let abort = CancellationToken::new();
    let running = Provisioning { id: job.id.clone(), abort: abort.clone() };
    engine::runtime_of(ctx, &thread.id, |runtime| runtime.provisioning = Some(running));
    let (task_ctx, thread_id) = (ctx.clone(), thread.id.clone());
    let provisioned = run_provisioning(task_ctx, thread_id, job, abort);
    engine::background(ctx, "provisioning", provisioned);
    Ok(())
}

pub fn cancel_provisioning(ctx: &Ctx, out: &Outbox, thread: &ThreadRow) -> ApiResult<()> {
    let running = engine::runtime_of(ctx, &thread.id, |runtime| runtime.provisioning.take());
    let Some(running) = running else { return Ok(()) };
    running.abort.cancel();
    let text = "Provisioning stopped by user request";
    let stopped = vec![step("provisioning-stopped", text, "completed", ctx.now(), None)];
    append_provisioning(ctx, out, thread, &running.id, "cancelled", stopped)?;
    engine::relabel_waits(ctx, out, &thread.id, PROVISIONING_WAIT, None)
}
