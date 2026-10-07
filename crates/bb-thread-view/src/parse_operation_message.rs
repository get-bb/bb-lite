//! System and operation events into operation, interaction and error messages: the port of
//! `parse-operation-message.ts`.

use serde_json::{Map, Value, json};

use crate::event::{self, field, object_field, str_field};
use crate::format::{capitalize, js_trim, message_id, ownership_change_verb};
use crate::rows::{
    ApprovalDetail, ApprovalTag, ApprovalTarget, ApprovalWork, FormLifecycle, FormTag, FormWork,
    ParentChange, ParentChangeAction, PermissionGrantApprovalFields, PermissionGrantApprovalTag,
    PermissionGrantLifecycle, PermissionGrantScope, QuestionLifecycle, QuestionTag, QuestionWork,
    RowStatus, WorkDetail,
};
use crate::types::{
    ErrorMessage, EventMeta, InteractionMessage, Message, MessageBase, OperationMessage,
    OperationType, ProjectionOptions,
};

/// `THREAD_CONTEXT_CLEAR_OPERATION`.
pub const THREAD_CONTEXT_CLEAR_OPERATION: &str = "context_clear";

/// `provisioningTitleForStatus`.
pub fn provisioning_title_for_status(status: RowStatus) -> &'static str {
    match status {
        RowStatus::Pending => "Provisioning thread",
        RowStatus::Completed => "Provisioned thread",
        RowStatus::Error => "Provisioning thread failed",
        RowStatus::Interrupted => "Provisioning thread interrupted",
    }
}

fn read_provisioning_transcript(entries: &[Value]) -> Option<Vec<Value>> {
    let result: Vec<Value> = entries
        .iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let key = js_trim(str_field(entry, "key")?);
            let text = js_trim(str_field(entry, "text")?);
            if key.is_empty() || text.is_empty() {
                return None;
            }
            let mut next = object.clone();
            next.insert("key".into(), Value::from(key));
            next.insert("text".into(), Value::from(text));
            if str_field(entry, "type") == Some("step") {
                let status = match field(entry, "status") {
                    None | Some(Value::Null) => Value::from("started"),
                    Some(status) => status.clone(),
                };
                next.insert("status".into(), status);
            } else {
                next.remove("status");
            }
            Some(Value::Object(next))
        })
        .collect();
    (!result.is_empty()).then_some(result)
}

/// `mergeTranscriptEntries`: incoming steps replace the existing step with the same key.
pub fn merge_transcript_entries(
    existing: Option<&[Value]>,
    incoming: Option<&[Value]>,
) -> Option<Vec<Value>> {
    let mut result: Vec<Value> = existing.map(<[Value]>::to_vec).unwrap_or_default();
    for entry in incoming.unwrap_or_default() {
        let existing_step = if str_field(entry, "type") == Some("step") {
            let key = field(entry, "key");
            result.iter().position(|candidate| {
                str_field(candidate, "type") == Some("step") && field(candidate, "key") == key
            })
        } else {
            None
        };
        match existing_step {
            Some(index) => result[index] = entry.clone(),
            None => result.push(entry.clone()),
        }
    }
    (!result.is_empty()).then_some(result)
}

fn with_thread_name(thread_name: &str, verb: &str) -> String {
    let name = js_trim(thread_name);
    if name.is_empty() { capitalize(verb) } else { format!("{name} {verb}") }
}

fn thread_interrupted_title(reason: &str) -> &'static str {
    match reason {
        "host-removed" => "Stopped because the machine was removed",
        "manual-stop" => "Stopped manually",
        "host-daemon-restarted" => "Stopped — host daemon restarted",
        "provider-turn-idle" => "Stopped — provider turn stopped responding",
        _ => "",
    }
}

fn nullable_string(record: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match record.get(key)? {
        Value::Null => Some(None),
        Value::String(text) => Some(Some(text.clone())),
        _ => None,
    }
}

fn parse_ownership_metadata(metadata: &Map<String, Value>) -> Option<ParentChange> {
    let action = match metadata.get("action")?.as_str()? {
        "assign" => ParentChangeAction::Assign,
        "release" => ParentChangeAction::Release,
        "transfer" => ParentChangeAction::Transfer,
        _ => return None,
    };
    Some(ParentChange {
        action,
        next_parent_thread_id: nullable_string(metadata, "nextParentThreadId")?,
        next_parent_thread_title: nullable_string(metadata, "nextParentThreadTitle")?,
        previous_parent_thread_id: nullable_string(metadata, "previousParentThreadId")?,
        previous_parent_thread_title: nullable_string(metadata, "previousParentThreadTitle")?,
    })
}

fn ownership_change_title(status: &str, metadata: Option<&ParentChange>, name: &str) -> String {
    if status == "failed" {
        return "Ownership change failed".into();
    }
    if status != "completed" {
        return format!("Ownership change {status}");
    }
    let Some(metadata) = metadata else {
        return "Ownership change completed".into();
    };
    let parent_title = match metadata.action {
        ParentChangeAction::Release => metadata.previous_parent_thread_title.as_deref(),
        _ => metadata.next_parent_thread_title.as_deref(),
    };
    let parent = parent_title.map(js_trim).filter(|title| !title.is_empty()).unwrap_or("parent");
    with_thread_name(name, &format!("{} {parent}", ownership_change_verb(metadata.action)))
}

struct OperationFields {
    op_type: OperationType,
    title: String,
    detail: Option<String>,
    status: RowStatus,
    merge_key: Option<String>,
    transcript: Option<Vec<Value>>,
    parent_change: Option<Option<ParentChange>>,
}

impl OperationFields {
    fn new(op_type: OperationType, title: impl Into<String>, status: RowStatus) -> Self {
        Self {
            op_type,
            title: title.into(),
            detail: None,
            status,
            merge_key: None,
            transcript: None,
            parent_change: None,
        }
    }

    fn detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail;
        self
    }
}

fn base_for(event: &Value, meta: &EventMeta, id: String, started: bool) -> MessageBase {
    MessageBase {
        id,
        thread_id: event::thread_id(event).unwrap_or_default().to_string(),
        source_seq_start: meta.seq,
        source_seq_end: meta.seq,
        created_at: meta.created_at,
        scope: event::scope_or_thread(event),
        started_at: started.then_some(meta.created_at),
        parent_tool_call_id: None,
    }
}

fn op(event: &Value, meta: &EventMeta, fields: OperationFields) -> Message {
    let key = format!("{}:{}", fields.op_type.as_str(), meta.seq);
    let id = message_id(event::thread_id(event).unwrap_or_default(), "op", &key);
    Message::Operation(OperationMessage {
        base: base_for(event, meta, id, true),
        op_type: fields.op_type,
        title: fields.title,
        detail: fields.detail,
        completed_at: (fields.status != RowStatus::Pending).then_some(meta.created_at),
        status: fields.status,
        merge_key: fields.merge_key,
        transcript: fields.transcript,
        parent_change: fields.parent_change,
    })
}

fn thread_operation_message(event: &Value, meta: &EventMeta, thread_name: &str) -> Message {
    let operation = str_field(event, "operation").unwrap_or_default();
    let status = str_field(event, "status").unwrap_or_default();
    let metadata = object_field(event, "metadata");
    let ownership_change = operation == "ownership_change";
    let parent_change =
        if ownership_change { metadata.and_then(parse_ownership_metadata) } else { None };
    let title = if ownership_change {
        ownership_change_title(status, parent_change.as_ref(), thread_name)
    } else if operation == THREAD_CONTEXT_CLEAR_OPERATION && status == "completed" {
        "Context cleared".to_string()
    } else {
        format!("{} {status}", capitalize(&operation.replace('_', " ")))
    };
    let message_detail = js_trim(str_field(event, "message").unwrap_or_default());
    let mut detail_parts = Vec::new();
    if !message_detail.is_empty() && message_detail != title {
        detail_parts.push(message_detail.to_string());
    }
    if let Some(branch) = metadata.and_then(|m| m.get("branch")).and_then(Value::as_str)
        && !branch.is_empty()
    {
        detail_parts.push(format!("Branch: {branch}"));
    }
    let row_status = match status {
        "completed" | "noop" => RowStatus::Completed,
        "failed" => RowStatus::Error,
        _ => RowStatus::Pending,
    };
    let mut fields = OperationFields::new(OperationType::Operation, title, row_status)
        .detail((!detail_parts.is_empty()).then(|| detail_parts.join(" • ")));
    fields.merge_key = str_field(event, "operationId").map(str::to_string);
    fields.parent_change = Some(parent_change);
    op(event, meta, fields)
}

fn plugin_form_presentation(interaction: &Value) -> Value {
    let payload = field(interaction, "payload");
    let mut presentation = match payload.and_then(|p| field(p, "presentation")) {
        Some(presentation) if !presentation.is_null() => presentation.clone(),
        _ => {
            let title = js_string(payload.and_then(|p| field(p, "title")));
            json!({
                "label": {
                    "pending": format!("Waiting for {title}"),
                    "completed": format!("Submitted {title}"),
                },
                "icon": { "glyph": "Toolbox" },
            })
        }
    };
    let description = field(interaction, "resolution").and_then(|r| field(r, "description"));
    if let (Some(description), Some(object)) = (description, presentation.as_object_mut()) {
        for key in ["title", "detail"] {
            if let Some(value) = field(description, key) {
                object.insert(key.into(), value.clone());
            }
        }
    }
    presentation
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn build_interaction_lifecycle_message(event: &Value, meta: &EventMeta) -> Option<Message> {
    let interaction = field(event, "interaction")?;
    let status = str_field(interaction, "status").unwrap_or_default();
    let status_reason = optional_string(field(interaction, "statusReason"));
    let interaction_id = str_field(interaction, "id").unwrap_or_default().to_string();
    let payload = field(interaction, "payload")?;
    let resolution = field(interaction, "resolution");
    let row_status = match status {
        "resolved" => RowStatus::Completed,
        "interrupted" => RowStatus::Interrupted,
        _ => RowStatus::Pending,
    };
    let thread_id = event::thread_id(event).unwrap_or_default();
    let message = |work_kind: &str, work: WorkDetail| {
        let id = message_id(thread_id, work_kind, &interaction_id);
        Message::Interaction(InteractionMessage {
            base: base_for(event, meta, id, true),
            status: row_status,
            work,
        })
    };
    match str_field(payload, "kind") {
        Some("user_question") => {
            let lifecycle = match status {
                "resolved" => QuestionLifecycle::Answered,
                "resolving" => QuestionLifecycle::Resolving,
                "interrupted" => QuestionLifecycle::Interrupted,
                _ => QuestionLifecycle::Pending,
            };
            let work = QuestionWork {
                work_kind: QuestionTag,
                interaction_id: interaction_id.clone(),
                lifecycle,
                questions: event::array_field(payload, "questions").cloned().unwrap_or_default(),
                answers: resolution.and_then(|r| object_field(r, "answers")).cloned(),
                status_reason,
            };
            Some(message(QuestionTag::VALUE, WorkDetail::Question(work)))
        }
        Some("plugin") => {
            let lifecycle = match status {
                "resolved" => FormLifecycle::Submitted,
                "interrupted" => FormLifecycle::Cancelled,
                _ => FormLifecycle::Pending,
            };
            let origin = field(interaction, "origin");
            let origin_str = |key| origin.and_then(|o| str_field(o, key)).unwrap_or_default();
            let payload_value = resolution
                .and_then(|r| field(r, "description"))
                .and_then(|d| field(d, "payload"))
                .filter(|value| !value.is_null())
                .cloned();
            let work = FormWork {
                work_kind: FormTag,
                interaction_id: interaction_id.clone(),
                plugin_id: origin_str("pluginId").to_string(),
                renderer_id: origin_str("rendererId").to_string(),
                title: str_field(payload, "title").unwrap_or_default().to_string(),
                lifecycle,
                status_reason,
                presentation: plugin_form_presentation(interaction),
                payload: payload_value,
            };
            Some(message(FormTag::VALUE, WorkDetail::Form(work)))
        }
        Some("approval") => {
            let subject = field(payload, "subject")?;
            if str_field(subject, "kind") != Some("permission_grant") {
                return None;
            }
            let decision = resolution.and_then(|r| str_field(r, "decision"));
            let lifecycle = match (status, decision) {
                ("resolved", Some("deny")) => PermissionGrantLifecycle::Denied,
                ("resolved", _) => PermissionGrantLifecycle::Granted,
                ("resolving", _) => PermissionGrantLifecycle::Resolving,
                ("interrupted", _) => PermissionGrantLifecycle::Interrupted,
                _ => PermissionGrantLifecycle::Pending,
            };
            let grant_scope = match decision {
                Some("allow_once") => Some(PermissionGrantScope::Turn),
                Some("allow_for_session") => Some(PermissionGrantScope::Session),
                _ => None,
            };
            let work = ApprovalWork {
                work_kind: ApprovalTag,
                interaction_id: interaction_id.clone(),
                target: ApprovalTarget {
                    item_id: str_field(subject, "itemId").unwrap_or_default().to_string(),
                    tool_name: optional_string(field(subject, "toolName")),
                },
                approval: ApprovalDetail::PermissionGrant(PermissionGrantApprovalFields {
                    approval_kind: PermissionGrantApprovalTag,
                    lifecycle,
                    grant_scope,
                    status_reason,
                }),
            };
            Some(message(ApprovalTag::VALUE, WorkDetail::Approval(work)))
        }
        _ => None,
    }
}

fn environment_detail(event: &Value) -> String {
    event::array_field(event, "entries")
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|entry| {
            let source = match field(entry, "source") {
                Some(Value::String(text)) if text == "shell" => "shell".to_string(),
                Some(source) if field(source, "plugin").is_some() => {
                    js_string(field(source, "plugin"))
                }
                source => js_string(source.and_then(|s| field(s, "core"))),
            };
            let value = str_field(entry, "value").unwrap_or("••••••");
            let reason = match str_field(entry, "reason") {
                Some(reason) if !reason.is_empty() => format!(" — {reason}"),
                _ => String::new(),
            };
            format!("{}={value} ({source}){reason}", js_string(field(entry, "name")))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn warning_message(event: &Value, meta: &EventMeta) -> Message {
    let category = str_field(event, "category");
    let summary = str_field(event, "summary");
    let details = str_field(event, "details");
    let labeled = matches!(category, Some("deprecation" | "config"));
    let parts = if labeled { vec![summary, details] } else { vec![details] };
    let detail = parts.into_iter().flatten().filter(|p| !p.is_empty()).collect::<Vec<_>>();
    let detail = detail.join("\n");
    let title = match category {
        Some("deprecation") => "Deprecation notice",
        Some("config") => "Configuration warning",
        _ => summary.map(js_trim).filter(|s| !s.is_empty()).unwrap_or("Warning"),
    };
    let op_type = match category {
        Some("deprecation") => OperationType::Deprecation,
        _ => OperationType::Warning,
    };
    let fields = OperationFields::new(op_type, title, RowStatus::Completed)
        .detail((!detail.is_empty()).then_some(detail));
    op(event, meta, fields)
}

/// `parseOperationMessage`: an [`Message::Operation`] or [`Message::Interaction`], or `None` for
/// events that do not project to one.
pub fn parse_operation_message(
    event: &Value,
    meta: &EventMeta,
    options: &ProjectionOptions,
) -> Option<Message> {
    match event::event_type(event) {
        "provider/modelFallback" => {
            let title = format!(
                "Model fallback: {} → {}",
                js_string(field(event, "originalModel")),
                js_string(field(event, "fallbackModel"))
            );
            let fields = OperationFields::new(OperationType::Warning, title, RowStatus::Completed)
                .detail(optional_string(field(event, "message")));
            Some(op(event, meta, fields))
        }
        "provider.env-resolved" => {
            if !options.include_diagnostic_operations {
                return None;
            }
            let detail = environment_detail(event);
            let fields = OperationFields::new(
                OperationType::ProviderEnvironment,
                "Provider environment resolved",
                RowStatus::Completed,
            )
            .detail((!detail.is_empty()).then_some(detail));
            Some(op(event, meta, fields))
        }
        "provider/warning" => Some(warning_message(event, meta)),
        "system/thread/interrupted" => {
            let title = if str_field(event, "cause") == Some("host-connection-lost") {
                "Stopped — connection to host was lost"
            } else {
                thread_interrupted_title(str_field(event, "reason").unwrap_or_default())
            };
            let fields = OperationFields::new(
                OperationType::ThreadInterrupted,
                title,
                RowStatus::Interrupted,
            );
            Some(op(event, meta, fields))
        }
        "system/thread-provisioning" => {
            let provisioning_id = str_field(event, "provisioningId").unwrap_or_default();
            if provisioning_id.starts_with("thread-start:") {
                return None;
            }
            let status = match str_field(event, "status")? {
                "active" => RowStatus::Pending,
                "completed" => RowStatus::Completed,
                "failed" => RowStatus::Error,
                "cancelled" => RowStatus::Interrupted,
                _ => return None,
            };
            let mut fields = OperationFields::new(
                OperationType::ThreadProvisioning,
                provisioning_title_for_status(status),
                status,
            );
            fields.merge_key = Some(provisioning_id.to_string());
            fields.transcript = event::array_field(event, "entries")
                .and_then(|entries| read_provisioning_transcript(entries));
            Some(op(event, meta, fields))
        }
        "system/operation" => match str_field(event, "operation") {
            Some("plugin_interaction" | "edit_message") => None,
            _ => Some(thread_operation_message(event, meta, &options.thread_name)),
        },
        "system/interaction/lifecycle" => build_interaction_lifecycle_message(event, meta),
        "thread/context/cleared" => Some(op(
            event,
            meta,
            OperationFields::new(
                OperationType::ContextClear,
                "Context cleared",
                RowStatus::Completed,
            ),
        )),
        _ => None,
    }
}

fn interrupted_operation_title(op_type: OperationType) -> Option<&'static str> {
    match op_type {
        OperationType::Operation => Some("Operation interrupted"),
        OperationType::ThreadProvisioning => {
            Some(provisioning_title_for_status(RowStatus::Interrupted))
        }
        OperationType::Compaction => Some("Context compaction interrupted"),
        OperationType::ContextClear => Some("Context clear interrupted"),
        _ => None,
    }
}

/// `interruptOperationMessage`: a pending operation becomes interrupted.
pub fn interrupt_operation_message(message: &mut OperationMessage) {
    if message.status != RowStatus::Pending {
        return;
    }
    message.status = RowStatus::Interrupted;
    message.completed_at = Some(message.base.created_at);
    if let Some(title) = interrupted_operation_title(message.op_type) {
        message.title = title.to_string();
    }
}

/// `finalizeOperationMessage`: settles a still-pending operation at the end of the projection.
pub fn finalize_operation_message(message: &mut OperationMessage, options: &ProjectionOptions) {
    if message.status != RowStatus::Pending {
        return;
    }
    if options.thread_status == "error" && message.op_type == OperationType::ThreadProvisioning {
        message.status = RowStatus::Error;
        message.title = provisioning_title_for_status(RowStatus::Error).to_string();
        message.completed_at = Some(message.base.created_at);
        return;
    }
    interrupt_operation_message(message);
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `parseErrorMessage`: `provider/error` and `system/error` events.
pub fn parse_error_message(event: &Value, meta: &EventMeta) -> Option<ErrorMessage> {
    let raw_type = event::event_type(event);
    if raw_type != "provider/error" && raw_type != "system/error" {
        return None;
    }
    let provider = raw_type == "provider/error";
    let message = str_field(event, "message").filter(|m| !m.is_empty());
    let detail = str_field(event, "detail").filter(|d| !d.is_empty() && Some(*d) != message);
    let id =
        message_id(event::thread_id(event).unwrap_or_default(), "error", &meta.seq.to_string());
    Some(ErrorMessage {
        base: base_for(event, meta, id, false),
        message: message.unwrap_or("Error event").to_string(),
        detail: detail.map(str::to_string),
        raw_type: raw_type.to_string(),
        provider_error_info: field(event, "errorInfo")
            .filter(|info| provider && is_truthy(info))
            .cloned(),
        will_retry: if provider { event::bool_field(event, "willRetry") } else { None },
    })
}
