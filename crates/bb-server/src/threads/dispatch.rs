//! The send checkpoint and queue drain (`apps/server/src/threads/dispatch.ts`).

use bb_core::{RunnerErrorCode, SubmitTurnArgs, SubmitTurnMode, SubmitTurnResult, new_id};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::attachments::{AttachmentTarget, deliver_attachments};
use super::core::{Outbox, environment_unavailable, not_writable};
use super::engine::{self, ThreadFailure};
use super::execution::{
    ExecutionTuple, ThreadTurnInitiator, recorded_execution, to_runner_options,
};
use super::session_spec::{SessionEnvironment, build_session_spec};
use crate::context::Ctx;
use crate::db::RowValues;
use crate::db::environments::get_environment;
use crate::db::events::is_queue_auto_send_paused;
use crate::db::hosts::{HostLookup, find_host};
use crate::db::pending_interactions::has_turn_bound_interaction;
use crate::db::queued_messages::{
    NewQueuedMessage, QueuedMessageRow, delete_queued_messages, get_queued_message,
    insert_queued_message, list_queued_messages, parse_queued_content, parse_queued_notice,
    parse_queued_wait, queued_initiator, queued_message_not_found, set_queued_message_wait,
};
use crate::db::threads::{ThreadRow, get_thread, patch_thread};
use crate::domain::changes::ThreadChangeKind;
use crate::domain::environment::EnvironmentStatus;
use crate::domain::events::thread_scope;
use crate::domain::queued_message::{QueuedMessageWaitingOn, QueuedMessageWaitingOnKind};
use crate::domain::thread::{ThreadLifecycleEventType, ThreadStatus};
use crate::environments::manager::path_for;
use crate::error::{ApiError, ApiResult, conflict, error_message, thread_not_found};
use crate::threads::mutations::SendQueuedMessageMode;

/// `SendMessageRequest["mode"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SendMode {
    Start,
    Steer,
    SteerIfActive,
    QueueIfActive,
    Auto,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OutboundMessage {
    /// `PromptInput[]`.
    pub input: Vec<Value>,
    pub execution: ExecutionTuple,
    pub sender_thread_id: Option<String>,
    /// `ThreadTurnInitiator`.
    pub initiator: String,
    /// `QueuedMessageSystemNotice | null`.
    pub system_notice: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DispatchArgs {
    pub message: OutboundMessage,
    pub mode: SendMode,
    pub send_at: Option<i64>,
    pub rows: Vec<QueuedMessageRow>,
    pub send_now: bool,
}

#[derive(Clone, Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum Delivery {
    Sent,
    Queued { row: QueuedMessageRow },
}

const MAX_DRAIN_ROUNDS: usize = 20;
const FAILURE_REASON_MAX_LENGTH: usize = 200;

fn utf16_len(text: &str) -> i64 {
    text.encode_utf16().count() as i64
}

fn attribute(input: &[Value], sender_thread_id: Option<&str>) -> Vec<Value> {
    let Some(sender) = sender_thread_id else { return input.to_vec() };
    let prefix = format!("[bb message from thread:{sender}]\n\n");
    let shift = utf16_len(&prefix);
    let Some(first) = input.iter().position(|part| part["type"] == "text") else {
        let lead = json!({ "type": "text", "text": prefix, "mentions": [] });
        return std::iter::once(lead).chain(input.iter().cloned()).collect();
    };
    let mut parts = input.to_vec();
    let part = &mut parts[first];
    let text = part["text"].as_str().unwrap_or_default();
    part["text"] = Value::String(format!("{prefix}{text}"));
    if let Some(mentions) = part.get_mut("mentions").and_then(Value::as_array_mut) {
        for mention in mentions {
            for key in ["start", "end"] {
                let at = mention[key].as_i64().unwrap_or_default();
                mention[key] = json!(at + shift);
            }
        }
    }
    parts
}

pub fn attributed_message(message: &OutboundMessage) -> OutboundMessage {
    let input = attribute(&message.input, message.sender_thread_id.as_deref());
    OutboundMessage { input, ..message.clone() }
}

/// `target` is a `TurnRequestTarget`; returns a `client/turn/requested` event.
pub fn turn_request_event(message: &OutboundMessage, request_id: &str, target: Value) -> Value {
    let starts = target["kind"] == "thread-start";
    let mut event = Map::new();
    event.insert("type".into(), json!("client/turn/requested"));
    event.insert("scope".into(), thread_scope());
    event.insert("direction".into(), json!("outbound"));
    event.insert("requestId".into(), json!(request_id));
    event.insert("source".into(), json!(if starts { "spawn" } else { "tell" }));
    event.insert("initiator".into(), json!(message.initiator));
    event.insert("senderThreadId".into(), json!(message.sender_thread_id));
    if let Some(notice) = &message.system_notice {
        event.insert("systemMessageKind".into(), notice["kind"].clone());
        if let Some(subject) = notice.get("subject") {
            event.insert("systemMessageSubject".into(), subject.clone());
        }
    }
    event.insert("input".into(), json!(message.input));
    event.insert("target".into(), target);
    let method = if starts { "thread/start" } else { "turn/start" };
    event.insert("request".into(), json!({ "method": method, "params": {} }));
    let execution = recorded_execution(message.execution.clone());
    event.insert("execution".into(), json!(execution));
    Value::Object(event)
}

pub fn consume_rows(
    ctx: &Ctx,
    out: &Outbox,
    thread: &ThreadRow,
    rows: &[QueuedMessageRow],
) -> ApiResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
    delete_queued_messages(&ctx.db, &ids)?;
    out.thread(&thread.id, vec![ThreadChangeKind::QueueChanged], None);
    Ok(())
}

pub fn session_environment_of(ctx: &Ctx, thread: &ThreadRow) -> ApiResult<SessionEnvironment> {
    let row = match &thread.environment_id {
        Some(id) => get_environment(&ctx.db, id)?,
        None => None,
    };
    let Some(row) = row else {
        let details = json!({ "reason": "never_attached", "environmentStatus": null });
        return Err(environment_unavailable(details));
    };
    let path = match row.status {
        EnvironmentStatus::Ready => path_for(ctx, &row.id)?,
        _ => None,
    };
    let Some(path) = path else {
        let destroyed = row.status == EnvironmentStatus::Destroyed;
        let reason = if destroyed { "destroyed" } else { "provisioning" };
        let details = json!({ "reason": reason, "environmentStatus": row.status });
        return Err(environment_unavailable(details));
    };
    Ok(SessionEnvironment { id: row.id, host_id: row.host_id, path })
}

fn has_ready_workspace(ctx: &Ctx, thread: &ThreadRow) -> ApiResult<bool> {
    let Some(id) = &thread.environment_id else { return Ok(false) };
    let environment = get_environment(&ctx.db, id)?;
    Ok(environment.is_some_and(|found| found.status == EnvironmentStatus::Ready))
}

fn current_wait(
    ctx: &Ctx,
    thread: &ThreadRow,
    args: &DispatchArgs,
) -> ApiResult<Option<QueuedMessageWaitingOn>> {
    let db = &ctx.db;
    let mode = args.mode;
    if !args.send_now && args.send_at.is_some_and(|at| at > db.now()) {
        return Ok(Some(QueuedMessageWaitingOn::Time));
    }
    if thread.status == ThreadStatus::Stopping {
        return Ok(Some(QueuedMessageWaitingOn::Stopping));
    }
    let active = thread.status == ThreadStatus::Active;
    if active && mode == SendMode::Start {
        return Err(not_writable(thread, "already_active", "Thread is already active"));
    }
    let environment = match &thread.environment_id {
        Some(id) => get_environment(db, id)?,
        None => None,
    };
    if let Some(environment) = environment
        && !ctx.runners.is_connected(&environment.host_id)
    {
        let host = find_host(db, HostLookup::Id, &environment.host_id)?;
        let host_name = host.map_or(environment.host_id, |host| host.name);
        return Ok(Some(QueuedMessageWaitingOn::HostOffline { host_name }));
    }
    if active && mode == SendMode::QueueIfActive {
        return Ok(Some(QueuedMessageWaitingOn::ThreadBusy));
    }
    if active && thread.active_turn_id.is_none() {
        return Ok(Some(QueuedMessageWaitingOn::TurnStarting));
    }
    if thread.status == ThreadStatus::Starting {
        return Ok(Some(QueuedMessageWaitingOn::Provisioning));
    }
    if mode != SendMode::Start && has_turn_bound_interaction(db, &thread.id)? {
        return Ok(Some(QueuedMessageWaitingOn::Interaction));
    }
    Ok(None)
}

fn record_wait(
    ctx: &Ctx,
    thread: &ThreadRow,
    args: &DispatchArgs,
    waiting_on: QueuedMessageWaitingOn,
) -> ApiResult<QueuedMessageRow> {
    let encoded = serde_json::to_string(&waiting_on)?;
    let lead = args.rows.first();
    if let Some(lead) = lead
        && lead.waiting_on.as_deref() == Some(encoded.as_str())
    {
        return Ok(lead.clone());
    }
    engine::commit(ctx, |out| {
        out.thread(&thread.id, vec![ThreadChangeKind::QueueChanged], None);
        if let Some(lead) = lead {
            set_queued_message_wait(&ctx.db, &args.rows, Some(&waiting_on))?;
            return Ok(QueuedMessageRow { waiting_on: Some(encoded), ..lead.clone() });
        }
        let message = &args.message;
        let system_notice = match &message.system_notice {
            Some(notice) => Some(serde_json::from_value(notice.clone())?),
            None => None,
        };
        let execution = &message.execution;
        let row = insert_queued_message(
            &ctx.db,
            NewQueuedMessage {
                thread_id: thread.id.clone(),
                sender_thread_id: message.sender_thread_id.clone(),
                send_at: args.send_at,
                content: message.input.clone(),
                model: execution.model.clone(),
                reasoning_level: execution.reasoning_level.as_str().to_owned(),
                permission_mode: execution.permission_mode.as_str().to_owned(),
                service_tier: execution.service_tier.as_str().to_owned(),
                waiting_on: Some(waiting_on),
                system_notice,
            },
        )?;
        Ok(row)
    })
}

fn settle_rejected_turn(
    ctx: &Ctx,
    thread_id: &str,
    request_id: &str,
    starts: bool,
    error: &ApiError,
) -> ApiResult<()> {
    engine::runtime_of(ctx, thread_id, |runtime| {
        if runtime.pending_start.as_deref() == Some(request_id) {
            runtime.pending_start = None;
        }
        if runtime.cancelled_start.as_deref() == Some(request_id) {
            runtime.cancelled_start = None;
        }
    });
    let Some(thread) = get_thread(&ctx.db, thread_id)? else { return Ok(()) };
    if thread.deleted_at.is_some() {
        return Ok(());
    }
    let code = error.code();
    let runner_code = RunnerErrorCode::parse(code).as_str() == code;
    let reason = if runner_code { code } else { "failed" };
    let message = error_message(error);
    engine::commit(ctx, |out| {
        let rejection = json!({
            "type": "client/turn/rejected",
            "scope": thread_scope(),
            "requestId": request_id,
            "reason": reason,
            "message": message,
        });
        engine::append(ctx, out, &thread, &[rejection])?;
        if !starts || reason == "competing_turn" {
            return Ok(());
        }
        let failure = ThreadFailure {
            code: "thread_command_failed".to_owned(),
            message: "Command turn.submit failed".to_owned(),
            detail: message.clone(),
        };
        engine::fail_thread(ctx, out, &thread, &failure, None)
    })
}

/// Fires `submitTurn` in the background; `args` are the runner's `SubmitTurnArgs`.
pub fn submit_to_runner(
    ctx: &Ctx,
    thread: &ThreadRow,
    host_id: &str,
    args: Value,
) -> ApiResult<()> {
    let thread_id = thread.id.clone();
    let request_id = args["clientRequestId"].as_str().unwrap_or_default().to_owned();
    let starts = args["mode"]["kind"] == "start";
    if starts {
        engine::runtime_of(ctx, &thread_id, |runtime| {
            runtime.pending_start = Some(request_id.clone());
        });
    }
    let (host, row) = (host_id.to_owned(), thread.clone());
    let task_ctx = ctx.clone();
    let accepted = engine::on_host(ctx, host_id, move |runner| async move {
        let mut args = args;
        let input: Vec<Value> = serde_json::from_value(args["input"].take())?;
        let target = AttachmentTarget { host_id: &host, runner: &runner, thread: &row };
        args["input"] = json!(deliver_attachments(&task_ctx, target, input).await?);
        let result = runner.call("submitTurn", args).await?;
        let result: SubmitTurnResult = serde_json::from_value(result)?;
        Ok(match result {
            SubmitTurnResult::Started { provider_thread_id } => provider_thread_id,
            SubmitTurnResult::Steered { provider_thread_id, .. } => provider_thread_id,
        })
    });
    let task_ctx = ctx.clone();
    let settled = async move {
        let ctx = task_ctx;
        let outcome = accepted.await;
        let queued = ctx.clone();
        let id = thread_id.clone();
        let work = async move {
            match outcome {
                Ok(provider_thread_id) => {
                    let Some(thread) = get_thread(&queued.db, &id)? else { return Ok(()) };
                    if thread.provider_thread_id.as_deref() == Some(provider_thread_id.as_str()) {
                        return Ok(());
                    }
                    let patch = RowValues::new().set("providerThreadId", provider_thread_id);
                    patch_thread(&queued.db, &id, &patch, false)?;
                    Ok(())
                }
                Err(error) => settle_rejected_turn(&queued, &id, &request_id, starts, &error),
            }
        };
        engine::in_thread(&ctx, &thread_id, work).await
    };
    engine::background(ctx, "submit turn", settled);
    Ok(())
}

fn initiator_of(message: &OutboundMessage) -> ApiResult<ThreadTurnInitiator> {
    Ok(serde_json::from_value(json!(message.initiator))?)
}

async fn submit_turn(ctx: &Ctx, thread: &ThreadRow, args: &DispatchArgs) -> ApiResult<()> {
    let mode = args.mode;
    let joins = thread.status == ThreadStatus::Active;
    if thread.status == ThreadStatus::Error && mode == SendMode::Steer {
        return Err(not_writable(thread, "errored", "Thread is not active"));
    }
    let environment = session_environment_of(ctx, thread)?;
    let message = attributed_message(&args.message);
    let session = build_session_spec(ctx, thread, &environment).await?;
    let request_id = new_id("creq");
    let expected_turn_id = thread.active_turn_id.clone();
    let steering = if joins && mode != SendMode::Auto { expected_turn_id.clone() } else { None };
    let runner_mode = match (&steering, joins) {
        (_, false) => SubmitTurnMode::Start,
        (Some(expected_turn_id), true) => {
            SubmitTurnMode::Steer { expected_turn_id: expected_turn_id.clone() }
        }
        (None, true) => SubmitTurnMode::Auto,
    };
    let target = if joins {
        let kind = if steering.is_some() { "steer" } else { "auto" };
        json!({ "kind": kind, "expectedTurnId": expected_turn_id })
    } else {
        json!({ "kind": "new-turn" })
    };
    let initiator = initiator_of(&message)?;
    engine::commit(ctx, |out| {
        consume_rows(ctx, out, thread, &args.rows)?;
        engine::append(ctx, out, thread, &[turn_request_event(&message, &request_id, target)])?;
        let tuple = &message.execution;
        let patch = RowValues::new()
            .set("model", tuple.model.clone())
            .set("reasoningLevel", tuple.reasoning_level.as_str())
            .set("permissionMode", tuple.permission_mode.as_str())
            .set("serviceTier", tuple.service_tier.as_str());
        patch_thread(&ctx.db, &thread.id, &patch, false)?;
        if !joins {
            engine::transition(ctx, out, &thread.id, ThreadLifecycleEventType::RunStarted)?;
        }
        let options = to_runner_options(&ctx.db, &thread.provider_id, tuple, initiator)?;
        let submit = SubmitTurnArgs {
            session,
            client_request_id: request_id.clone(),
            input: message.input.clone(),
            options,
            mode: runner_mode,
        };
        let submit = serde_json::to_value(&submit)?;
        let (ctx, thread, host_id) = (ctx.clone(), thread.clone(), environment.host_id.clone());
        out.after(move || {
            if let Err(error) = submit_to_runner(&ctx, &thread, &host_id, submit) {
                let err = error.to_string();
                ctx.log.error("Thread follow-up failed", json!({ "err": err }));
            }
        });
        Ok(())
    })
}

fn is_standalone_builtin_clear_command(input: &[Value]) -> bool {
    if input.iter().any(|item| item["type"] != "text") {
        return false;
    }
    let is_clear = |mention: &Value| {
        let resource = &mention["resource"];
        resource["kind"] == "command" && resource["trigger"] == "/" && resource["name"] == "clear"
    };
    let mentions = |item: &Value| item["mentions"].as_array().cloned().unwrap_or_default();
    let selected: Vec<(Value, &Value)> = input
        .iter()
        .flat_map(|item| mentions(item).into_iter().filter(is_clear).map(move |m| (m, item)))
        .collect();
    let [(mention, item)] = selected.as_slice() else { return false };
    let resource = &mention["resource"];
    if resource["source"] != "command" || resource["origin"] != "builtin" {
        return false;
    }
    let range = |item: &Value, mention: &Value| {
        let text: Vec<u16> = item["text"].as_str().unwrap_or_default().encode_utf16().collect();
        let start = mention["start"].as_u64().unwrap_or_default() as usize;
        let end = mention["end"].as_u64().unwrap_or_default() as usize;
        (text, start.min(end), end)
    };
    let (text, start, end) = range(item, mention);
    if text.get(start..end).map(String::from_utf16_lossy).as_deref() != Some("/clear") {
        return false;
    }
    input.iter().all(|item| {
        let mut text: Vec<u16> = item["text"].as_str().unwrap_or_default().encode_utf16().collect();
        let mut removed: Vec<(usize, usize)> = mentions(item)
            .iter()
            .filter(|mention| is_clear(mention))
            .map(|mention| {
                let (_, start, end) = range(item, mention);
                (start.min(text.len()), end.min(text.len()))
            })
            .collect();
        removed.sort_by_key(|range| std::cmp::Reverse(range.0));
        for (start, end) in removed {
            if start <= end {
                text.drain(start..end);
            }
        }
        String::from_utf16_lossy(&text).trim().is_empty()
    })
}

pub async fn dispatch_message(
    ctx: &Ctx,
    thread_id: &str,
    args: DispatchArgs,
) -> ApiResult<Delivery> {
    let Some(thread) = get_thread(&ctx.db, thread_id)? else { return Err(thread_not_found()) };
    if thread.deleted_at.is_some() {
        return Err(not_writable(&thread, "deleted", "Thread is deleted"));
    }
    if thread.archived_at.is_some() {
        return Err(not_writable(&thread, "archived", "Thread is archived"));
    }
    if let Some(waiting_on) = current_wait(ctx, &thread, &args)? {
        let row = record_wait(ctx, &thread, &args, waiting_on)?;
        return Ok(Delivery::Queued { row });
    }
    let settled = thread.status != ThreadStatus::Active;
    let unprepared = settled && !has_ready_workspace(ctx, &thread)?;
    if thread.status == ThreadStatus::Pending || unprepared {
        engine::begin_provisioning(ctx, &thread, args)?;
        return Ok(Delivery::Sent);
    }
    if settled && is_standalone_builtin_clear_command(&args.message.input) {
        engine::commit(ctx, |out| consume_rows(ctx, out, &thread, &args.rows))?;
        engine::reset_context(ctx, &thread).await?;
        return Ok(Delivery::Sent);
    }
    submit_turn(ctx, &thread, &args).await?;
    Ok(Delivery::Sent)
}

fn next_eligible(ctx: &Ctx, thread: &ThreadRow) -> ApiResult<Option<QueuedMessageRow>> {
    let db = &ctx.db;
    let rows = list_queued_messages(db, &thread.id)?;
    if rows.is_empty() {
        return Ok(None);
    }
    let paused = is_queue_auto_send_paused(db, &thread.id)?;
    let idle = matches!(thread.status, ThreadStatus::Idle | ThreadStatus::Pending);
    let joinable = thread.status == ThreadStatus::Active && thread.active_turn_id.is_some();
    let host_id = engine::host_of(ctx, thread)?;
    for row in rows {
        if row.failure_reason.is_some() {
            continue;
        }
        let kind = parse_queued_wait(&row).ok().flatten().map(|wait| wait.kind());
        let turn_bound = matches!(kind, None | Some(QueuedMessageWaitingOnKind::ThreadBusy));
        let ordinary = turn_bound || kind == Some(QueuedMessageWaitingOnKind::TurnStarting);
        if ordinary && paused && row.system_notice.is_none() {
            continue;
        }
        let eligible = match kind {
            Some(QueuedMessageWaitingOnKind::TurnStarting) => idle || joinable,
            Some(QueuedMessageWaitingOnKind::Time) => row.send_at.is_some_and(|at| at <= db.now()),
            Some(QueuedMessageWaitingOnKind::HostOffline) => {
                host_id.as_deref().is_some_and(|host| ctx.runners.is_connected(host))
            }
            Some(QueuedMessageWaitingOnKind::Interaction) => {
                !has_turn_bound_interaction(db, &thread.id)?
            }
            Some(QueuedMessageWaitingOnKind::Provisioning) => false,
            _ => idle,
        };
        if eligible {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

fn message_of(row: &QueuedMessageRow) -> ApiResult<OutboundMessage> {
    let execution: ExecutionTuple = serde_json::from_value(json!({
        "model": row.model,
        "reasoningLevel": row.reasoning_level,
        "permissionMode": row.permission_mode,
        "serviceTier": row.service_tier,
    }))?;
    let initiator = serde_json::to_value(queued_initiator(row))?;
    let notice = parse_queued_notice(row)?;
    Ok(OutboundMessage {
        input: parse_queued_content(row)?,
        execution,
        sender_thread_id: row.sender_thread_id.clone(),
        initiator: initiator.as_str().unwrap_or("user").to_owned(),
        system_notice: notice.map(serde_json::to_value).transpose()?,
    })
}

async fn dispatch_row(
    ctx: &Ctx,
    thread_id: &str,
    row: &QueuedMessageRow,
    mode: SendMode,
    send_now: bool,
) -> ApiResult<Delivery> {
    let message = message_of(row)?;
    let rows = vec![row.clone()];
    let args = DispatchArgs { message, mode, send_at: row.send_at, rows, send_now };
    dispatch_message(ctx, thread_id, args).await
}

fn record_drain_failure(ctx: &Ctx, row: &QueuedMessageRow, error: &ApiError) -> ApiResult<()> {
    let thread_id = &row.thread_id;
    let message = error_message(error);
    let fields = json!({ "err": message, "threadId": thread_id });
    ctx.log.warn("Queued message dispatch failed", fields);
    let mut reason: String = message.chars().take(FAILURE_REASON_MAX_LENGTH).collect();
    if reason.is_empty() {
        reason = "failed".to_owned();
    }
    let sql = "UPDATE queued_thread_messages SET failure_reason = ? WHERE id = ?";
    ctx.db.run(sql, [reason.as_str(), row.id.as_str()])?;
    ctx.hub.thread(thread_id, vec![ThreadChangeKind::QueueChanged], None);
    Ok(())
}

pub async fn drain_queue(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    for _ in 0..MAX_DRAIN_ROUNDS {
        let Some(thread) = get_thread(&ctx.db, thread_id)? else { return Ok(()) };
        if thread.status == ThreadStatus::Stopping {
            return Ok(());
        }
        if thread.archived_at.is_some() || thread.deleted_at.is_some() {
            return Ok(());
        }
        let Some(row) = next_eligible(ctx, &thread)? else { return Ok(()) };
        match dispatch_row(ctx, thread_id, &row, SendMode::Auto, false).await {
            Ok(Delivery::Queued { .. }) => return Ok(()),
            Ok(Delivery::Sent) => {}
            Err(error) => return record_drain_failure(ctx, &row, &error),
        }
    }
    Ok(())
}

pub async fn send_queued_message_now(
    ctx: &Ctx,
    thread_id: &str,
    queued_message_id: &str,
    mode: SendQueuedMessageMode,
) -> ApiResult<Delivery> {
    let db = &ctx.db;
    let Some(row) = get_queued_message(db, thread_id, queued_message_id)? else {
        return Err(queued_message_not_found());
    };
    let sql = "UPDATE queued_thread_messages SET failure_reason = NULL WHERE id = ?";
    db.run(sql, [queued_message_id])?;
    let mode = match mode {
        SendQueuedMessageMode::Auto => SendMode::Auto,
        SendQueuedMessageMode::Steer => SendMode::Steer,
    };
    let outcome = dispatch_row(ctx, thread_id, &row, mode, true).await?;
    let Delivery::Queued { row: queued } = &outcome else { return Ok(outcome) };
    if mode == SendMode::Steer {
        return Ok(outcome);
    }
    let wait = parse_queued_wait(queued).ok().flatten();
    let kind = wait.map_or(QueuedMessageWaitingOnKind::ThreadBusy, |wait| wait.kind());
    if kind == QueuedMessageWaitingOnKind::Stopping {
        return Ok(outcome);
    }
    let kind = kind.as_str();
    Err(conflict(format!("This message cannot be sent yet: it waits on {kind}.")))
}
