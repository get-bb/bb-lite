//! Batched child-outcome notices to parent threads. Port of
//! `apps/server/src/threads/parent-notices.ts`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::dispatch::{DispatchArgs, OutboundMessage, SendMode, dispatch_message};
use super::engine::later;
use super::execution::{ExecutionRequest, resolve_turn_execution};
use crate::context::Ctx;
use crate::db::event_read::last_output;
use crate::db::threads::{ThreadRow, get_thread};
use crate::domain::pending_interaction::PendingInteraction;
use crate::error::ApiResult;

pub const NOTICE_BATCH_DELAY_MS: i64 = 2_000;
const SYSTEM_PREFIX: &str = "[bb system]\n\n";
const OUTPUT_EXCERPT_MAX_CHARS: usize = 4_000;
const OUTPUT_TRUNCATION_MARKER: &str = "\n\n[... output truncated ...]";
const REVIEW_GUIDANCE: &str = "Review the thread before deciding next steps.";
const BLOCKER_GUIDANCE: &str = "Review the blocker. If you can resolve it from existing context, reply to the thread with guidance. Otherwise, ask the user for the missing decision.";
const BLOCKER_FALLBACK: &str = "It is blocked on a pending interaction.";
const BLOCKER_MAX_LINES: usize = 4;
const BLOCKER_MAX_CHARS: usize = 700;

#[derive(Clone, Debug, PartialEq)]
pub struct ChildOutcome {
    /// `ThreadEventTurnStatus`.
    pub status: String,
    pub failure_context: Option<String>,
    /// `ChildThreadOutcome["interruption"]`.
    pub interruption: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OutcomeItem {
    pub outcome: ChildOutcome,
    pub child: ThreadRow,
    pub output: Option<String>,
}

pub struct NoticeBatch {
    pub items: Vec<OutcomeItem>,
    pub due_at: i64,
    pub timer: tokio::task::AbortHandle,
}

/// The message a parent receives: its prompt input and the queued row's
/// `systemNotice` kind and subject.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemNotice {
    pub input: Vec<Value>,
    pub kind: String,
    pub subject: Value,
}

enum Segment<'a> {
    Text(String),
    Thread(&'a ThreadRow),
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn utf16_prefix(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, char) in text.char_indices() {
        units += char.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

fn label(thread: &ThreadRow) -> String {
    let title = thread.title.as_deref().map(str::trim).unwrap_or_default();
    if title.is_empty() { thread.id.clone() } else { title.to_owned() }
}

fn compose(segments: &[Segment]) -> Vec<Value> {
    let mut text = SYSTEM_PREFIX.to_owned();
    let mut mentions = Vec::new();
    for segment in segments {
        let thread = match segment {
            Segment::Text(part) => {
                text.push_str(part);
                continue;
            }
            Segment::Thread(thread) => thread,
        };
        let start = utf16_len(&text);
        text.push_str(&format!("@thread:{}", thread.id));
        let resource = json!({
            "kind": "thread",
            "threadId": thread.id,
            "projectId": thread.project_id,
            "label": label(thread),
        });
        mentions.push(json!({ "start": start, "end": utf16_len(&text), "resource": resource }));
    }
    vec![json!({ "type": "text", "text": text, "mentions": mentions })]
}

fn subject_of(thread: &ThreadRow, outcomes: Option<Vec<Value>>) -> Value {
    let mut subject =
        json!({ "kind": "thread", "threadId": thread.id, "threadName": label(thread) });
    if let (Some(outcomes), Some(fields)) = (outcomes, subject.as_object_mut()) {
        fields.insert("outcomes".to_owned(), Value::Array(outcomes));
    }
    subject
}

fn interruption_cause(interruption: Option<&Value>) -> &'static str {
    let field = |key: &str| interruption.and_then(|value| value[key].as_str());
    if field("cause") == Some("host-connection-lost") {
        return " because its host connection was lost";
    }
    if field("reason") == Some("host-daemon-restarted") {
        " because its host daemon restarted"
    } else {
        ""
    }
}

fn outcome_label(item: &OutcomeItem) -> String {
    let outcome = &item.outcome;
    if let Some(context) = &outcome.failure_context {
        return context.clone();
    }
    if outcome.status != "interrupted" {
        return outcome.status.clone();
    }
    format!("was interrupted{}", interruption_cause(outcome.interruption.as_ref()))
}

fn output_excerpt(output: Option<&str>) -> String {
    let text = output.unwrap_or_default().trim();
    if text.is_empty() {
        return "No final output was recorded.".to_owned();
    }
    if utf16_len(text) <= OUTPUT_EXCERPT_MAX_CHARS {
        return text.to_owned();
    }
    let kept = OUTPUT_EXCERPT_MAX_CHARS - utf16_len(OUTPUT_TRUNCATION_MARKER);
    format!("{}{OUTPUT_TRUNCATION_MARKER}", utf16_prefix(text, kept).trim_end())
}

/// The notice for a parent's batch of child outcomes (`outcomeNotice`).
pub fn outcome_notice(items: &[OutcomeItem]) -> SystemNotice {
    let outcomes: Vec<Value> = items
        .iter()
        .map(|item| {
            let mut outcome = Map::new();
            outcome.insert("threadId".to_owned(), json!(item.child.id));
            outcome.insert("status".to_owned(), json!(item.outcome.status));
            if let Some(interruption) = &item.outcome.interruption {
                outcome.insert("interruption".to_owned(), interruption.clone());
            }
            Value::Object(outcome)
        })
        .collect();
    if items.len() > 1 {
        let mut segments = vec![Segment::Text("Child thread updates:".to_owned())];
        for (index, item) in items.iter().enumerate() {
            let bullet = if index == 0 { "\n\n- " } else { "\n- " };
            segments.push(Segment::Text(bullet.to_owned()));
            segments.push(Segment::Thread(&item.child));
            segments.push(Segment::Text(format!(" {}.", outcome_label(item))));
        }
        let count = items.len();
        return SystemNotice {
            input: compose(&segments),
            kind: "child-outcome-batch".to_owned(),
            subject: json!({ "kind": "thread-batch", "count": count, "outcomes": outcomes }),
        };
    }
    let Some(item) = items.first() else {
        return SystemNotice { input: compose(&[]), kind: String::new(), subject: Value::Null };
    };
    let status = &item.outcome.status;
    let body = if status == "completed" {
        format!(" completed:\n\n{}", output_excerpt(item.output.as_deref()))
    } else {
        format!(" {}.\n\n{REVIEW_GUIDANCE}", outcome_label(item))
    };
    SystemNotice {
        input: compose(&[Segment::Thread(&item.child), Segment::Text(body)]),
        kind: format!("child-{status}"),
        subject: subject_of(&item.child, Some(outcomes)),
    }
}

fn deliver_notice(ctx: &Ctx, parent_thread_id: &str, notice: SystemNotice) {
    let (task_ctx, parent_id) = (ctx.clone(), parent_thread_id.to_owned());
    later(ctx, parent_thread_id, "parent notice", async move {
        let ctx = &task_ctx;
        let Some(parent) = get_thread(&ctx.db, &parent_id)? else { return Ok(()) };
        if parent.deleted_at.is_some() || parent.archived_at.is_some() {
            return Ok(());
        }
        let SystemNotice { input, kind, subject } = notice;
        let message = OutboundMessage {
            input,
            execution: resolve_turn_execution(&ctx.db, &parent, &ExecutionRequest::default())?,
            sender_thread_id: None,
            initiator: "system".to_owned(),
            system_notice: Some(json!({ "kind": kind, "subject": subject })),
        };
        let args = DispatchArgs {
            message,
            mode: SendMode::Auto,
            send_at: None,
            rows: vec![],
            send_now: false,
        };
        dispatch_message(ctx, &parent_id, args).await.map(drop)
    });
}

fn flush_batch(ctx: &Ctx, parent_thread_id: &str) {
    let Some(batch) = ctx.engine.notice_batches.lock().remove(parent_thread_id) else { return };
    batch.timer.abort();
    deliver_notice(ctx, parent_thread_id, outcome_notice(&batch.items));
}

pub fn flush_due_notices(ctx: &Ctx, now: i64) -> ApiResult<()> {
    let due: Vec<String> = ctx
        .engine
        .notice_batches
        .lock()
        .iter()
        .filter(|(_, batch)| batch.due_at <= now)
        .map(|(parent_thread_id, _)| parent_thread_id.clone())
        .collect();
    for parent_thread_id in due {
        flush_batch(ctx, &parent_thread_id);
    }
    Ok(())
}

pub fn queue_child_outcome(ctx: &Ctx, child: &ThreadRow, outcome: ChildOutcome) -> ApiResult<()> {
    let Some(parent_thread_id) = child.parent_thread_id.clone() else { return Ok(()) };
    if child.origin_kind.is_some() {
        return Ok(());
    }
    let completed = outcome.status == "completed";
    let output = if completed { last_output(&ctx.db, &child.id)? } else { None };
    let failure_context = outcome.failure_context.clone();
    let item = OutcomeItem { outcome, child: child.clone(), output };
    let weak = Arc::downgrade(ctx);
    let parent_id = parent_thread_id.clone();
    let timer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(NOTICE_BATCH_DELAY_MS as u64)).await;
        if let Some(ctx) = weak.upgrade() {
            flush_batch(&ctx, &parent_id);
        }
    })
    .abort_handle();
    let due_at = ctx.now() + NOTICE_BATCH_DELAY_MS;
    let mut batches = ctx.engine.notice_batches.lock();
    let mut items: Vec<OutcomeItem> = match batches.remove(&parent_thread_id) {
        Some(batch) => {
            batch.timer.abort();
            batch.items
        }
        None => Vec::new(),
    };
    items.retain(|entry| {
        entry.child.id != child.id || entry.outcome.failure_context != failure_context
    });
    items.push(item);
    batches.insert(parent_thread_id, NoticeBatch { items, due_at, timer });
    Ok(())
}

fn blocker_summary(interaction: &PendingInteraction) -> String {
    let payload = &interaction.payload;
    let kind = payload["kind"].as_str().unwrap_or_default();
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    let details: Vec<String> = if kind == "user_question" {
        let questions = payload["questions"].as_array().map(Vec::as_slice).unwrap_or_default();
        questions.iter().map(|question| text(&question["prompt"])).collect()
    } else if kind != "approval" {
        vec![text(&payload["title"])]
    } else if payload["subject"]["kind"].as_str() == Some("command") {
        vec![format!("Command: {}", text(&payload["subject"]["command"]))]
    } else {
        vec![]
    };
    let lines: Vec<&str> =
        details.iter().map(|line| line.trim()).filter(|line| !line.is_empty()).collect();
    if lines.is_empty() {
        return BLOCKER_FALLBACK.to_owned();
    }
    let kind = if kind == "approval" {
        payload["subject"]["kind"].as_str().unwrap_or_default()
    } else {
        "request"
    };
    let heading = format!("Blocked on {}:", kind.replace('_', " "));
    let mut summary = vec![heading.as_str()];
    summary.extend(lines.iter().take(BLOCKER_MAX_LINES));
    utf16_prefix(&summary.join("\n"), BLOCKER_MAX_CHARS).to_owned()
}

/// The notice a parent receives when its child waits on an interaction.
pub fn blocked_notice(child: &ThreadRow, interaction: &PendingInteraction) -> SystemNotice {
    let summary = blocker_summary(interaction);
    let body = format!(" needs help.\n{summary}\n\n{BLOCKER_GUIDANCE}");
    SystemNotice {
        input: compose(&[Segment::Thread(child), Segment::Text(body)]),
        kind: "child-needs-attention".to_owned(),
        subject: subject_of(child, None),
    }
}

pub fn notify_parent_blocked(
    ctx: &Ctx,
    child: &ThreadRow,
    interaction: &PendingInteraction,
) -> ApiResult<()> {
    let Some(parent_thread_id) = &child.parent_thread_id else { return Ok(()) };
    if child.origin_kind.is_some() {
        return Ok(());
    }
    deliver_notice(ctx, parent_thread_id, blocked_notice(child, interaction));
    Ok(())
}
