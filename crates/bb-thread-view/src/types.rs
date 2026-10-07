//! The projection's intermediate types: the port of `event-projection-types.ts`.
//!
//! Messages reuse the row-contract field structs from [`crate::rows`] so a message turns into a row
//! by attaching a [`RowBase`](crate::rows::RowBase).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::{self, EventScope};
use crate::rows::{
    ApprovalStatus, ConversationAttachments, ParentChange, RowStatus, UserConversationFields,
    WorkDetail, WorkflowWork,
};

/// `EventMeta`: the stored row's id, sequence number and creation time (ms).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventMeta {
    pub id: String,
    pub seq: i64,
    pub created_at: i64,
}

/// `ThreadEventWithMeta`: a stored thread event (read through [`crate::event`]) and its metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadEventWithMeta {
    pub event: Value,
    pub meta: EventMeta,
}

impl ThreadEventWithMeta {
    pub fn event_type(&self) -> &str {
        event::event_type(&self.event)
    }

    pub fn turn_id(&self) -> Option<&str> {
        event::turn_id(&self.event)
    }
}

/// `ProjectionOptions`; `thread_status` is the thread's `status` string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionOptions {
    pub include_diagnostic_operations: bool,
    pub thread_status: String,
    pub thread_name: String,
}

/// `getEventTurnId`.
pub fn get_event_turn_id(event: &Value) -> Option<&str> {
    event::turn_id(event)
}

/// `getEventProviderThreadId`.
pub fn get_event_provider_thread_id(event: &Value) -> Option<&str> {
    event::provider_thread_id(event)
}

/// `getEventParentToolCallId`.
pub fn get_event_parent_tool_call_id(event: &Value) -> Option<&str> {
    event::parent_tool_call_id(event)
}

/// `scopeForTurn`.
pub fn scope_for_turn(turn_id: Option<&str>) -> EventScope {
    EventScope::for_turn(turn_id)
}

/// `areThreadEventScopesEqual`.
pub fn are_thread_event_scopes_equal(left: &EventScope, right: &EventScope) -> bool {
    left == right
}

/// `MessageBase`: the fields every projected message carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBase {
    pub id: String,
    pub thread_id: String,
    pub source_seq_start: i64,
    pub source_seq_end: i64,
    pub created_at: i64,
    pub scope: EventScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
}

impl MessageBase {
    /// `getMessageStartedAt`: `startedAt ?? createdAt`.
    pub fn started_at_or_created(&self) -> i64 {
        self.started_at.unwrap_or(self.created_at)
    }

    pub fn turn_id(&self) -> Option<&str> {
        self.scope.turn_id()
    }
}

/// `UserMessage` (`kind: "user"`): the user conversation row fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub text: String,
    pub attachments: Option<ConversationAttachments>,
    #[serde(flatten)]
    pub fields: UserConversationFields,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssistantTextStatus {
    Streaming,
    Completed,
}

/// `AssistantMessage` (`kind: "assistant-text"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub text: String,
    pub status: AssistantTextStatus,
}

/// `ExecMessage` (`kind: "exec"`): a command, tool call or delegation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub status: RowStatus,
    #[serde(flatten)]
    pub exec: ExecDetail,
}

/// `detail` is a [`WorkDetail::Command`] or [`WorkDetail::Tool`] for commands and tool calls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExecDetail {
    Work(WorkDetail),
    Delegation(DelegationMessage),
}

/// `DelegationMessage` fields after `status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "workKind", rename = "delegation", rename_all = "camelCase")]
pub struct DelegationMessage {
    pub call_id: String,
    pub tool_name: String,
    pub child_ref: Option<String>,
    pub background: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub output: String,
    pub completed_at: Option<i64>,
    pub children: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

/// `ItemMessage` (`kind: "item"`): `work` is one of web-search, web-fetch, image-view,
/// image-generation, file-read, search, plan-steps or extension.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub status: RowStatus,
    #[serde(flatten)]
    pub work: WorkDetail,
}

/// `InteractionMessage` (`kind: "interaction"`): `work` is a permission-grant approval, a question
/// or a form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub status: RowStatus,
    #[serde(flatten)]
    pub work: WorkDetail,
}

/// `FileEditChange`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEditChange {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default)]
    pub move_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

/// `FileEditMessage` (`kind: "file-edit"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEditMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub call_id: String,
    pub changes: Vec<FileEditChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    pub approval_status: Option<ApprovalStatus>,
    pub status: RowStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

/// `OperationMessage["opType"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationType {
    Reasoning,
    ProviderEnvironment,
    Warning,
    Deprecation,
    ThreadInterrupted,
    ThreadProvisioning,
    Operation,
    Compaction,
    ContextClear,
}

impl OperationType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reasoning => "reasoning",
            Self::ProviderEnvironment => "provider-environment",
            Self::Warning => "warning",
            Self::Deprecation => "deprecation",
            Self::ThreadInterrupted => "thread-interrupted",
            Self::ThreadProvisioning => "thread-provisioning",
            Self::Operation => "operation",
            Self::Compaction => "compaction",
            Self::ContextClear => "context-clear",
        }
    }
}

/// `OperationMessage` (`kind: "operation"`); `transcript` holds `ProvisioningTranscriptEntry` JSON.
/// `parent_change` is `None` for TypeScript `undefined` and `Some(None)` for `null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub op_type: OperationType,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub status: RowStatus,
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<Vec<Value>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub parent_change: Option<Option<ParentChange>>,
}

/// `WorkflowMessage` (`kind: "workflow"`): the workflow row fields plus grouping data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub family_id: Option<String>,
    pub skip_transcript: bool,
    pub status: RowStatus,
    /// Serialized without `workKind`: `Omit<..., "workKind">`.
    #[serde(flatten, with = "workflow_without_work_kind")]
    pub workflow: WorkflowWork,
}

/// `ErrorMessage` (`kind: "error"`); `provider_error_info` is `ProviderErrorInfo` JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub message: String,
    pub detail: Option<String>,
    pub raw_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_error_info: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub will_retry: Option<bool>,
}

/// `Message`: one projected item before it becomes a timeline row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Message {
    User(UserMessage),
    AssistantText(AssistantMessage),
    Exec(ExecMessage),
    Item(ItemMessage),
    FileEdit(FileEditMessage),
    Operation(OperationMessage),
    Interaction(InteractionMessage),
    Workflow(WorkflowMessage),
    Error(ErrorMessage),
}

impl Message {
    pub fn base(&self) -> &MessageBase {
        match self {
            Self::User(m) => &m.base,
            Self::AssistantText(m) => &m.base,
            Self::Exec(m) => &m.base,
            Self::Item(m) => &m.base,
            Self::FileEdit(m) => &m.base,
            Self::Operation(m) => &m.base,
            Self::Interaction(m) => &m.base,
            Self::Workflow(m) => &m.base,
            Self::Error(m) => &m.base,
        }
    }

    pub fn base_mut(&mut self) -> &mut MessageBase {
        match self {
            Self::User(m) => &mut m.base,
            Self::AssistantText(m) => &mut m.base,
            Self::Exec(m) => &mut m.base,
            Self::Item(m) => &mut m.base,
            Self::FileEdit(m) => &mut m.base,
            Self::Operation(m) => &mut m.base,
            Self::Interaction(m) => &mut m.base,
            Self::Workflow(m) => &mut m.base,
            Self::Error(m) => &mut m.base,
        }
    }

    /// The TypeScript `kind` discriminator.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::User(_) => "user",
            Self::AssistantText(_) => "assistant-text",
            Self::Exec(_) => "exec",
            Self::Item(_) => "item",
            Self::FileEdit(_) => "file-edit",
            Self::Operation(_) => "operation",
            Self::Interaction(_) => "interaction",
            Self::Workflow(_) => "workflow",
            Self::Error(_) => "error",
        }
    }
}

/// `ProjectedTurn`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedTurn {
    pub turn_id: String,
    pub thread_id: String,
    pub source_seq_start: i64,
    pub source_seq_end: i64,
    pub started_at: i64,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub status: RowStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_user_boundary_seqs: Option<Vec<i64>>,
    pub messages: Vec<Message>,
}

/// `ProjectionEntry`.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(into = "ProjectionEntryJson", from = "ProjectionEntryJson")]
pub enum ProjectionEntry {
    ProjectedMessage(Message),
    Turn(ProjectedTurn),
}

/// `Projection`; `active_thinking` is the domain `ActiveThinking` JSON.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Projection {
    pub entries: Vec<ProjectionEntry>,
    pub active_thinking: Option<Value>,
    pub active_workflows: Vec<WorkflowMessage>,
    pub active_background_commands: Vec<WorkflowMessage>,
}

/// Anything with mutable `sourceSeqEnd` and `createdAt` bounds.
pub trait MessageBounds {
    fn bounds_mut(&mut self) -> (&mut i64, &mut i64);
}

impl MessageBounds for MessageBase {
    fn bounds_mut(&mut self) -> (&mut i64, &mut i64) {
        (&mut self.source_seq_end, &mut self.created_at)
    }
}

impl MessageBounds for ProjectedTurn {
    fn bounds_mut(&mut self) -> (&mut i64, &mut i64) {
        (&mut self.source_seq_end, &mut self.created_at)
    }
}

/// `extendMessageBounds`.
pub fn extend_message_bounds<T: MessageBounds + ?Sized>(
    target: &mut T,
    source_seq_end: i64,
    created_at: i64,
) {
    let (seq_end, created) = target.bounds_mut();
    *seq_end = (*seq_end).max(source_seq_end);
    *created = (*created).max(created_at);
}

/// `VisibleTextBuffer`: text shown so far and the trailing partial line held back.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VisibleTextBuffer {
    pub visible: String,
    pub pending: String,
}

impl VisibleTextBuffer {
    /// `createVisibleTextBuffer`.
    pub fn new() -> Self {
        Self::default()
    }

    /// `appendVisibleText`.
    pub fn append(&mut self, delta: &str) {
        match delta.rfind('\n') {
            None => self.pending.push_str(delta),
            Some(last_newline) => {
                let pending = std::mem::take(&mut self.pending);
                self.visible.push_str(&pending);
                self.visible.push_str(&delta[..=last_newline]);
                self.pending = delta[last_newline + 1..].to_string();
            }
        }
    }

    /// `setVisibleText`.
    pub fn set(&mut self, text: &str, show_trailing_partial: bool) {
        let cut = if show_trailing_partial {
            text.len()
        } else {
            text.rfind('\n').map_or(0, |index| index + 1)
        };
        self.visible = text[..cut].to_string();
        self.pending = text[cut..].to_string();
    }

    /// `flushVisibleText`: moves the pending text into `visible`; false when nothing was pending.
    pub fn flush(&mut self) -> bool {
        if self.pending.is_empty() {
            return false;
        }
        let pending = std::mem::take(&mut self.pending);
        self.visible.push_str(&pending);
        true
    }
}

/// Deserializes a present field (including `null`) as `Some`: `field?: T | null`.
fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// The JSON shape of [`ProjectionEntry`]: `{ kind: "projected-message", message }` or
/// `{ kind: "turn", turn }`.
#[allow(clippy::large_enum_variant)]
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum ProjectionEntryJson {
    ProjectedMessage { message: Message },
    Turn { turn: ProjectedTurn },
}

impl From<ProjectionEntryJson> for ProjectionEntry {
    fn from(entry: ProjectionEntryJson) -> Self {
        match entry {
            ProjectionEntryJson::ProjectedMessage { message } => Self::ProjectedMessage(message),
            ProjectionEntryJson::Turn { turn } => Self::Turn(turn),
        }
    }
}

impl From<ProjectionEntry> for ProjectionEntryJson {
    fn from(entry: ProjectionEntry) -> Self {
        match entry {
            ProjectionEntry::ProjectedMessage(message) => Self::ProjectedMessage { message },
            ProjectionEntry::Turn(turn) => Self::Turn { turn },
        }
    }
}

/// `WorkflowMessage` carries the workflow row fields without `workKind`.
mod workflow_without_work_kind {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use serde_json::{Map, Value};

    use crate::rows::WorkflowWork;

    pub fn serialize<S: Serializer>(work: &WorkflowWork, serializer: S) -> Result<S::Ok, S::Error> {
        let mut value = serde_json::to_value(work).map_err(serde::ser::Error::custom)?;
        if let Some(fields) = value.as_object_mut() {
            fields.shift_remove("workKind");
        }
        value.serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<WorkflowWork, D::Error> {
        let mut fields = Map::<String, Value>::deserialize(deserializer)?;
        fields.insert("workKind".to_string(), Value::from("workflow"));
        serde_json::from_value(Value::Object(fields)).map_err(serde::de::Error::custom)
    }
}
