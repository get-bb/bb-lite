//! Item lifecycle parsing: the port of `item-lifecycle.ts`.
//!
//! Turns `item/started` / `item/completed` (and delta / progress) events into the partial
//! updates the projection merges into exec, item, file-edit and compaction messages.
//!
//! TypeScript `undefined` and `null` both map to `None`; fields that are `undefined` in the
//! TypeScript output are skipped when serializing, fields that are always present (possibly `null`)
//! are serialized as `null`.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::event::{self, field, str_field};
use crate::rows::{
    ActivityIntent, ApprovalStatus, ExtensionTag, ExtensionWork, FileReadTag, FileReadWork,
    ImageGenerationTag, ImageGenerationWork, ImageViewTag, ImageViewWork, PlanStepsTag,
    PlanStepsWork, RowStatus, SearchMode, SearchTag, SearchWork, WebFetchTag, WebFetchWork,
    WebSearchTag, WebSearchWork, WorkDetail,
};
use crate::tool_call_parsing::{
    TimelineActivityIntent, extract_shell_command_from_string, parse_shell_command_intents,
};
use crate::types::{EventMeta, FileEditChange, get_event_parent_tool_call_id};

impl From<TimelineActivityIntent> for ActivityIntent {
    fn from(intent: TimelineActivityIntent) -> Self {
        match intent {
            TimelineActivityIntent::Read { command, name, path } => {
                Self::Read { command, name, path }
            }
            TimelineActivityIntent::ListFiles { command, path } => {
                Self::ListFiles { command, path }
            }
            TimelineActivityIntent::Search { command, query, path } => {
                Self::Search { command, query, path }
            }
            TimelineActivityIntent::Unknown { command } => Self::Unknown { command },
        }
    }
}

/// `"begin" | "end"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleKind {
    Begin,
    End,
}

fn parse_row_status(status: &str) -> Option<RowStatus> {
    match status {
        "pending" => Some(RowStatus::Pending),
        "completed" => Some(RowStatus::Completed),
        "error" => Some(RowStatus::Error),
        "interrupted" => Some(RowStatus::Interrupted),
        _ => None,
    }
}

fn parse_approval_status(status: Option<&str>) -> Option<ApprovalStatus> {
    match status? {
        "waiting_for_approval" => Some(ApprovalStatus::WaitingForApproval),
        "denied" => Some(ApprovalStatus::Denied),
        _ => None,
    }
}

/// `itemStatusToExecStatus`: `failed` becomes `error`; other statuses pass through. `None` for a
/// missing or unknown status.
pub fn item_status_to_exec_status(status: Option<&str>) -> Option<RowStatus> {
    match status? {
        "failed" => Some(RowStatus::Error),
        other => parse_row_status(other),
    }
}

/// `CommandExecutionUpdate`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecutionUpdate {
    pub call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub activity_intents: Vec<ActivityIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// `None` when the item has no `exitCode`; `Some(None)` for a stored `null`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<Option<i64>>,
    pub completed_at: Option<i64>,
    /// Always present on command items (`null` when not awaiting approval).
    pub approval_status: Option<ApprovalStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<RowStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
}

/// `ToolCallExecutionUpdate`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallExecutionUpdate {
    pub call_id: String,
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    pub completed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<RowStatus>,
    pub tool_args: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_status: Option<ApprovalStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
}

/// `DelegationExecutionUpdate`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationExecutionUpdate {
    pub call_id: String,
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    pub completed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<RowStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
}

/// `ProviderExecutionUpdate`, tagged by `workKind`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "workKind")]
pub enum ProviderExecutionUpdate {
    #[serde(rename = "command")]
    Command(CommandExecutionUpdate),
    #[serde(rename = "tool")]
    Tool(ToolCallExecutionUpdate),
    #[serde(rename = "delegation")]
    Delegation(DelegationExecutionUpdate),
}

impl ProviderExecutionUpdate {
    pub fn call_id(&self) -> &str {
        match self {
            Self::Command(call) => &call.call_id,
            Self::Tool(call) => &call.call_id,
            Self::Delegation(call) => &call.call_id,
        }
    }
}

/// `ExecutionOutputUpdate`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOutputUpdate {
    pub call_id: String,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<RowStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// `ExecLifecycleEvent`, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ExecLifecycleEvent {
    Begin {
        call: ProviderExecutionUpdate,
    },
    End {
        call: ProviderExecutionUpdate,
    },
    #[serde(rename_all = "camelCase")]
    Output {
        output: ExecutionOutputUpdate,
        #[serde(skip_serializing_if = "is_false")]
        append_output: bool,
        #[serde(skip_serializing_if = "is_false")]
        replace_output: bool,
    },
}

impl ExecLifecycleEvent {
    fn call(kind: LifecycleKind, call: ProviderExecutionUpdate) -> Self {
        match kind {
            LifecycleKind::Begin => Self::Begin { call },
            LifecycleKind::End => Self::End { call },
        }
    }
}

fn is_started_or_completed(event_type: &str) -> bool {
    event_type == "item/started" || event_type == "item/completed"
}

/// The event's item when it is `item/started` / `item/completed` with an item of `item_type` and a
/// non-empty id.
fn lifecycle_item<'a>(decoded: &'a Value, item_type: &str) -> Option<(&'a Value, &'a str)> {
    if !is_started_or_completed(event::event_type(decoded)) {
        return None;
    }
    let item = event::item(decoded)?;
    if event::item_type(item) != Some(item_type) {
        return None;
    }
    let id = event::item_id(item).filter(|id| !id.is_empty())?;
    Some((item, id))
}

fn resolve_parent(decoded: &Value, parent_override: Option<&str>) -> Option<String> {
    parent_override
        .or_else(|| get_event_parent_tool_call_id(decoded))
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn presentation(item: &Value) -> Option<Value> {
    event::item_presentation(item).cloned()
}

fn opt_string(value: &Value, key: &str) -> Option<String> {
    str_field(value, key).map(str::to_string)
}

/// `parseExecLifecycleEvent`: command output deltas and command-execution items.
pub fn parse_exec_lifecycle_event(
    decoded: &Value,
    meta: &EventMeta,
    parent_tool_call_id_override: Option<&str>,
) -> Option<ExecLifecycleEvent> {
    let parent_tool_call_id = resolve_parent(decoded, parent_tool_call_id_override);
    if event::is_type(decoded, "item/commandExecution/outputDelta") {
        let call_id = event::item_id_field(decoded).filter(|id| !id.is_empty())?;
        let reset = field(decoded, "reset").is_some_and(js_truthy);
        return Some(ExecLifecycleEvent::Output {
            output: ExecutionOutputUpdate {
                call_id: call_id.to_string(),
                output: event::delta(decoded).unwrap_or_default().to_string(),
                status: Some(RowStatus::Pending),
                parent_tool_call_id,
            },
            append_output: !reset,
            replace_output: reset,
        });
    }
    let (item, call_id) = lifecycle_item(decoded, "commandExecution")?;
    let kind = lifecycle_kind(decoded);
    // `item.exitCode !== undefined && item.exitCode !== 0`: a `null` exit code counts as failed.
    let failed_exit = field(item, "exitCode").is_some_and(|code| code.as_f64() != Some(0.0));
    let command = str_field(item, "command").and_then(extract_shell_command_from_string);
    let activity_intents =
        parse_shell_command_intents(command.as_deref()).into_iter().map(Into::into).collect();
    let status = if failed_exit {
        Some(RowStatus::Error)
    } else {
        item_status_to_exec_status(event::item_status(item))
    };
    Some(ExecLifecycleEvent::call(
        kind,
        ProviderExecutionUpdate::Command(CommandExecutionUpdate {
            call_id: call_id.to_string(),
            command,
            cwd: opt_string(item, "cwd"),
            activity_intents,
            source: None,
            output: opt_string(item, "aggregatedOutput"),
            exit_code: field(item, "exitCode").map(|_| event::item_exit_code(item)),
            completed_at: completed_at(kind, meta),
            approval_status: parse_approval_status(event::item_approval_status(item)),
            status,
            presentation: presentation(item),
            parent_tool_call_id,
        }),
    ))
}

fn lifecycle_kind(decoded: &Value) -> LifecycleKind {
    match event::event_type(decoded) {
        "item/started" | "item/delegation/progress" => LifecycleKind::Begin,
        _ => LifecycleKind::End,
    }
}

fn completed_at(kind: LifecycleKind, meta: &EventMeta) -> Option<i64> {
    (kind == LifecycleKind::End).then_some(meta.created_at)
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn parse_delegation_item_lifecycle_event(
    decoded: &Value,
    meta: &EventMeta,
    parent_tool_call_id: Option<String>,
) -> Option<ExecLifecycleEvent> {
    let event_type = event::event_type(decoded);
    if !matches!(
        event_type,
        "item/started"
            | "item/completed"
            | "item/delegation/progress"
            | "item/delegation/completed"
    ) {
        return None;
    }
    let item = event::item(decoded)?;
    if event::item_type(item) != Some("delegation") {
        return None;
    }
    let kind = lifecycle_kind(decoded);
    let status = match kind {
        LifecycleKind::End => item_status_to_exec_status(event::item_status(item)),
        LifecycleKind::Begin => Some(RowStatus::Pending),
    };
    Some(ExecLifecycleEvent::call(
        kind,
        ProviderExecutionUpdate::Delegation(DelegationExecutionUpdate {
            call_id: event::item_id(item).unwrap_or_default().to_string(),
            tool_name: "delegation".to_string(),
            child_ref: opt_string(item, "childRef"),
            background: event::bool_field(item, "background"),
            subagent_type: None,
            description: opt_string(item, "label"),
            model: None,
            output: opt_string(item, "summary"),
            completed_at: completed_at(kind, meta),
            status,
            presentation: presentation(item),
            parent_tool_call_id,
        }),
    ))
}

/// `parseToolCallLifecycleEvent`: tool-call progress, delegation items and tool-call items.
pub fn parse_tool_call_lifecycle_event(
    decoded: &Value,
    meta: &EventMeta,
    parent_tool_call_id_override: Option<&str>,
) -> Option<ExecLifecycleEvent> {
    let parent_tool_call_id = resolve_parent(decoded, parent_tool_call_id_override);
    let event_type = event::event_type(decoded);
    if event_type == "item/toolCall/progress" || event_type == "item/mcpToolCall/progress" {
        return Some(ExecLifecycleEvent::Output {
            output: ExecutionOutputUpdate {
                call_id: event::item_id_field(decoded).unwrap_or_default().to_string(),
                output: event::message(decoded).unwrap_or("Progress update").to_string(),
                status: Some(RowStatus::Pending),
                parent_tool_call_id,
            },
            append_output: false,
            replace_output: false,
        });
    }
    if let Some(delegation) =
        parse_delegation_item_lifecycle_event(decoded, meta, parent_tool_call_id.clone())
    {
        return Some(delegation);
    }
    let (item, call_id) = lifecycle_item(decoded, "toolCall")?;
    let ended = event_type == "item/completed";
    let result = match field(item, "result") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(js_json_stringify(other)),
        None => None,
    };
    let server = str_field(item, "server").filter(|server| !server.is_empty());
    let tool = str_field(item, "tool").unwrap_or("undefined");
    let tool_name = match server {
        Some(server) => format!("{server}:{tool}"),
        None => tool.to_string(),
    };
    let kind = if ended { LifecycleKind::End } else { LifecycleKind::Begin };
    Some(ExecLifecycleEvent::call(
        kind,
        ProviderExecutionUpdate::Tool(ToolCallExecutionUpdate {
            call_id: call_id.to_string(),
            tool_name,
            output: if ended { result.or_else(|| opt_string(item, "error")) } else { None },
            completed_at: completed_at(kind, meta),
            status: if ended {
                item_status_to_exec_status(event::item_status(item))
            } else {
                Some(RowStatus::Pending)
            },
            tool_args: event::object_field(item, "arguments").cloned(),
            approval_status: None,
            presentation: presentation(item),
            parent_tool_call_id,
        }),
    ))
}

/// `ItemRowFields`: an item row's `status` and work detail (serialized flat, like TypeScript).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ItemRowFields {
    pub status: RowStatus,
    #[serde(flatten)]
    pub work: WorkDetail,
}

/// `ItemLifecycleEvent`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemLifecycleEvent {
    pub kind: LifecycleKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    pub row: ItemRowFields,
}

fn parse_search_mode(mode: Option<&str>) -> SearchMode {
    match mode {
        Some("path") => SearchMode::Path,
        Some("list") => SearchMode::List,
        _ => SearchMode::Content,
    }
}

/// `parseItemLifecycleEvent`: web search/fetch, image view/generation, file read, search, plan
/// steps and extension items.
pub fn parse_item_lifecycle_event(
    decoded: &Value,
    meta: &EventMeta,
    parent_tool_call_id_override: Option<&str>,
) -> Option<ItemLifecycleEvent> {
    if !is_started_or_completed(event::event_type(decoded)) {
        return None;
    }
    let item = event::item(decoded)?;
    let call_id = event::item_id(item).filter(|id| !id.is_empty())?.to_string();
    let parent_tool_call_id = resolve_parent(decoded, parent_tool_call_id_override);
    let ended = event::is_type(decoded, "item/completed");
    let settled = |status: Option<&str>| -> RowStatus {
        if !ended {
            return RowStatus::Pending;
        }
        match status {
            None | Some("pending") => RowStatus::Completed,
            Some(other) => item_status_to_exec_status(Some(other)).unwrap_or(RowStatus::Completed),
        }
    };
    let completed_at = ended.then_some(meta.created_at);
    let presented = presentation(item);
    let item_status = event::item_status(item);
    let path = || str_field(item, "path").unwrap_or_default().to_string();
    let (status, work) = match event::item_type(item)? {
        "webSearch" => (
            settled(None),
            WorkDetail::WebSearch(WebSearchWork {
                work_kind: WebSearchTag,
                call_id,
                queries: event::string_array_field(item, "queries")
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                completed_at,
                presentation: presented,
            }),
        ),
        "webFetch" => (
            settled(None),
            WorkDetail::WebFetch(WebFetchWork {
                work_kind: WebFetchTag,
                call_id,
                url: str_field(item, "url").unwrap_or_default().to_string(),
                prompt: opt_string(item, "prompt"),
                pattern: opt_string(item, "pattern"),
                completed_at,
                presentation: presented,
            }),
        ),
        "imageView" => (
            settled(None),
            WorkDetail::ImageView(ImageViewWork {
                work_kind: ImageViewTag,
                call_id,
                path: path(),
                completed_at,
                presentation: presented,
            }),
        ),
        "imageGeneration" => (
            settled(item_status),
            WorkDetail::ImageGeneration(ImageGenerationWork {
                work_kind: ImageGenerationTag,
                call_id,
                prompt: opt_string(item, "prompt"),
                path: opt_string(item, "path"),
                error: opt_string(item, "error"),
                transparent_background: event::bool_field(item, "transparentBackground")
                    .unwrap_or(false),
                completed_at,
                presentation: presented,
            }),
        ),
        "fileRead" => (
            settled(item_status),
            WorkDetail::FileRead(FileReadWork {
                work_kind: FileReadTag,
                call_id,
                path: path(),
                cmd: opt_string(item, "cmd"),
                completed_at,
                presentation: presented,
            }),
        ),
        "search" => (
            settled(item_status),
            WorkDetail::Search(SearchWork {
                work_kind: SearchTag,
                call_id,
                mode: parse_search_mode(str_field(item, "mode")),
                query: str_field(item, "query").unwrap_or_default().to_string(),
                path: opt_string(item, "path"),
                cmd: opt_string(item, "cmd"),
                completed_at,
                presentation: presented,
            }),
        ),
        "planSteps" => (
            settled(item_status),
            WorkDetail::PlanSteps(PlanStepsWork {
                work_kind: PlanStepsTag,
                call_id,
                steps: event::array_field(item, "steps").cloned().unwrap_or_default(),
                explanation: opt_string(item, "explanation"),
                completed_at,
                presentation: presented,
            }),
        ),
        "extension" => (
            settled(item_status),
            WorkDetail::Extension(ExtensionWork {
                work_kind: ExtensionTag,
                call_id,
                extension_kind: event::item_kind(item).unwrap_or_default().to_string(),
                payload: field(item, "payload").cloned().unwrap_or(Value::Null),
                completed_at,
                presentation: field(item, "presentation").cloned().unwrap_or(Value::Null),
            }),
        ),
        _ => return None,
    };
    Some(ItemLifecycleEvent {
        kind: if ended { LifecycleKind::End } else { LifecycleKind::Begin },
        parent_tool_call_id,
        row: ItemRowFields { status, work },
    })
}

/// `FileEditPartial`: an output delta or the item's changes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum FileEditPartial {
    #[serde(rename_all = "camelCase")]
    Output {
        call_id: String,
        stdout: String,
        /// Always [`RowStatus::Pending`].
        status: RowStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Changes {
        call_id: String,
        changes: Vec<FileEditChange>,
        approval_status: Option<ApprovalStatus>,
        status: Option<RowStatus>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
    },
}

/// `parseFileEditFromItemEvent`: file-change output deltas and file-change items.
pub fn parse_file_edit_from_item_event(
    decoded: &Value,
    parent_tool_call_id_override: Option<&str>,
) -> Option<FileEditPartial> {
    let parent_tool_call_id = resolve_parent(decoded, parent_tool_call_id_override);
    if event::is_type(decoded, "item/fileChange/outputDelta") {
        let call_id = event::item_id_field(decoded).filter(|id| !id.is_empty())?;
        return Some(FileEditPartial::Output {
            call_id: call_id.to_string(),
            stdout: event::delta(decoded).unwrap_or_default().to_string(),
            status: RowStatus::Pending,
            parent_tool_call_id,
        });
    }
    let (item, call_id) = lifecycle_item(decoded, "fileChange")?;
    let changes = event::array_field(item, "changes")
        .map(|changes| {
            changes
                .iter()
                .map(|change| FileEditChange {
                    path: str_field(change, "path").unwrap_or_default().to_string(),
                    kind: opt_string(change, "kind"),
                    move_path: opt_string(change, "movePath"),
                    diff: opt_string(change, "diff"),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(FileEditPartial::Changes {
        call_id: call_id.to_string(),
        changes,
        approval_status: parse_approval_status(event::item_approval_status(item)),
        status: item_status_to_exec_status(event::item_status(item)),
        presentation: presentation(item),
        parent_tool_call_id,
    })
}

/// `CompactionLifecycleEvent`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionLifecycleEvent {
    pub key: String,
    pub kind: LifecycleKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
}

fn get_compaction_key(decoded: &Value, meta: &EventMeta) -> String {
    let turn_id = event::turn_id(decoded);
    let event_type = event::event_type(decoded);
    if event_type == "thread/compacted" {
        // `requireThreadEventScopeTurnId` throws for a thread scope; fall through to the
        // sequence key instead (stored `thread/compacted` events are always turn-scoped).
        let scope = field(decoded, "scope");
        if let Some(scope) = scope.filter(|scope| str_field(scope, "kind") == Some("turn"))
            && let Some(id) = str_field(scope, "turnId")
        {
            return id.to_string();
        }
    }
    if is_started_or_completed(event_type) {
        if let Some(turn_id) = turn_id {
            return turn_id.to_string();
        }
        return event::event_item_id(decoded).unwrap_or_default().to_string();
    }
    turn_id.map_or_else(|| format!("seq-{}", meta.seq), str::to_string)
}

/// `parseCompactionLifecycleEvent`: context-compaction items and `thread/compacted`.
pub fn parse_compaction_lifecycle_event(
    decoded: &Value,
    meta: &EventMeta,
    parent_tool_call_id: Option<&str>,
) -> Option<CompactionLifecycleEvent> {
    let event_type = event::event_type(decoded);
    let compaction_item = is_started_or_completed(event_type)
        && event::event_item_type(decoded) == Some("contextCompaction");
    if !compaction_item && event_type != "thread/compacted" {
        return None;
    }
    Some(CompactionLifecycleEvent {
        key: get_compaction_key(decoded, meta),
        kind: if event_type == "item/started" { LifecycleKind::Begin } else { LifecycleKind::End },
        detail: None,
        parent_tool_call_id: parent_tool_call_id.filter(|id| !id.is_empty()).map(str::to_string),
    })
}

/// `shouldSuppressLowValueToolCall`: a pending or completed tool-like item whose presentation asks
/// to be suppressed.
pub fn should_suppress_low_value_tool_call(decoded: &Value) -> bool {
    if !is_started_or_completed(event::event_type(decoded)) {
        return false;
    }
    let Some(item) = event::item(decoded) else {
        return false;
    };
    match event::item_type(item) {
        Some(
            "toolCall" | "fileRead" | "search" | "planSteps" | "extension" | "delegation"
            | "fileChange",
        ) => {
            let suppress = event::item_presentation(item)
                .and_then(|presentation| event::bool_field(presentation, "suppress"));
            if suppress != Some(true) {
                return false;
            }
            matches!(event::item_status(item), Some("pending" | "completed"))
        }
        _ => false,
    }
}

/// `JSON.stringify` for a JSON value: integer-like keys first in ascending order, then the rest
/// in insertion order; numbers formatted like JavaScript.
pub fn js_json_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_js_json(value, &mut out);
    out
}

fn array_index_key(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

fn write_js_json(value: &Value, out: &mut String) {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => out.push_str(&value.to_string()),
        Value::Number(number) => out.push_str(&js_number_string(number)),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_js_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
            let mut named: Vec<(&String, &Value)> = Vec::new();
            for (key, inner) in map {
                match array_index_key(key) {
                    Some(index) => indexed.push((index, key, inner)),
                    None => named.push((key, inner)),
                }
            }
            indexed.sort_by_key(|(index, _, _)| *index);
            out.push('{');
            let entries = indexed.into_iter().map(|(_, key, inner)| (key, inner)).chain(named);
            for (position, (key, inner)) in entries.enumerate() {
                if position > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_js_json(inner, out);
            }
            out.push('}');
        }
    }
}

fn js_number_string(number: &serde_json::Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }
    let Some(float) = number.as_f64() else {
        return number.to_string();
    };
    if !float.is_finite() {
        return "null".to_string();
    }
    if float == 0.0 {
        return "0".to_string();
    }
    let magnitude = float.abs();
    if (1e-6..1e21).contains(&magnitude) {
        return format!("{float}");
    }
    let exponential = format!("{float:e}");
    match exponential.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => exponential,
    }
}
