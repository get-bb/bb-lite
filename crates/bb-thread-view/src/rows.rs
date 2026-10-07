//! The timeline row contract: the port of `packages/server-contract/src/thread-timeline.ts`.
//!
//! Every struct serializes with the keys in the order the zod objects declare them. Literal
//! discriminators (`kind`, `workKind`, `role`, `systemKind`, `operationKind`, `approvalKind`) are
//! zero-sized marker fields so they sit in their declared position instead of first; build them
//! with `Default::default()` (every marker implements `Default`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

macro_rules! literal_tag {
    ($(#[$meta:meta])* $name:ident = $value:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
        pub struct $name;

        impl $name {
            pub const VALUE: &'static str = $value;
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str($value)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                if value == $value {
                    Ok($name)
                } else {
                    Err(serde::de::Error::custom(format!(
                        "expected {:?}, found {:?}",
                        $value, value
                    )))
                }
            }
        }
    };
}

literal_tag!(ConversationTag = "conversation");
literal_tag!(SystemTag = "system");
literal_tag!(WorkTag = "work");
literal_tag!(TurnTag = "turn");
literal_tag!(UserRoleTag = "user");
literal_tag!(AssistantRoleTag = "assistant");
literal_tag!(OperationSystemKindTag = "operation");
literal_tag!(ParentChangeOperationTag = "parent-change");
literal_tag!(CommandTag = "command");
literal_tag!(ToolTag = "tool");
literal_tag!(FileChangeTag = "file-change");
literal_tag!(WebSearchTag = "web-search");
literal_tag!(WebFetchTag = "web-fetch");
literal_tag!(ImageViewTag = "image-view");
literal_tag!(ImageGenerationTag = "image-generation");
literal_tag!(FileReadTag = "file-read");
literal_tag!(SearchTag = "search");
literal_tag!(PlanStepsTag = "plan-steps");
literal_tag!(ExtensionTag = "extension");
literal_tag!(ApprovalTag = "approval");
literal_tag!(FileEditApprovalTag = "file-edit");
literal_tag!(PermissionGrantApprovalTag = "permission-grant");
literal_tag!(QuestionTag = "question");
literal_tag!(FormTag = "form");
literal_tag!(DelegationTag = "delegation");
literal_tag!(WorkflowTag = "workflow");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RowStatus {
    Pending,
    Completed,
    Error,
    Interrupted,
}

/// The non-null half of `TimelineApprovalStatus`; the contract field is `Option<ApprovalStatus>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    WaitingForApproval,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActivityIntent {
    Read { command: String, name: String, path: Option<String> },
    ListFiles { command: String, path: Option<String> },
    Search { command: String, query: Option<String>, path: Option<String> },
    Unknown { command: String },
}

impl ActivityIntent {
    pub fn command(&self) -> &str {
        match self {
            Self::Read { command, .. }
            | Self::ListFiles { command, .. }
            | Self::Search { command, .. }
            | Self::Unknown { command } => command,
        }
    }

    pub fn is_unknown(&self) -> bool {
        matches!(self, Self::Unknown { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowBase {
    pub id: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub source_seq_start: i64,
    pub source_seq_end: i64,
    pub started_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAttachments {
    pub web_images: u64,
    pub local_images: u64,
    pub local_files: u64,
    pub image_urls: Vec<String>,
    pub local_image_paths: Vec<String>,
    pub local_file_paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnRequestKind {
    Message,
    Steer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnRequestStatus {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurnRequest {
    pub is_grouped: bool,
    pub kind: TurnRequestKind,
    pub status: TurnRequestStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRow {
    #[serde(flatten)]
    pub base: RowBase,
    pub kind: ConversationTag,
    pub text: String,
    pub attachments: Option<ConversationAttachments>,
    #[serde(flatten)]
    pub role: ConversationRole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConversationRole {
    User(UserConversationFields),
    Assistant(AssistantConversationFields),
}

/// `initiator` is `"user" | "agent" | "system"`; `system_message_kind`, `system_message_subject`
/// and `mentions` are domain shapes passed through from the event as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserConversationFields {
    pub role: UserRoleTag,
    pub initiator: String,
    pub sender_thread_id: Option<String>,
    pub system_message_kind: String,
    pub system_message_subject: Option<Value>,
    pub turn_request: ConversationTurnRequest,
    pub mentions: Vec<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantConversationFields {
    pub role: AssistantRoleTag,
    pub turn_request: (),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemOperationKind {
    Generic,
    Reasoning,
    Compaction,
    ContextClear,
    ParentChange,
    ThreadProvisioning,
    ThreadInterrupted,
    ProviderUnhandled,
    Warning,
    Deprecation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParentChangeAction {
    Assign,
    Release,
    Transfer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentChange {
    pub action: ParentChangeAction,
    pub previous_parent_thread_id: Option<String>,
    pub previous_parent_thread_title: Option<String>,
    pub next_parent_thread_id: Option<String>,
    pub next_parent_thread_title: Option<String>,
}

/// `status` must be `Some` when `system` is [`SystemDetail::ParentChange`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemRow {
    #[serde(flatten)]
    pub base: RowBase,
    pub kind: SystemTag,
    pub title: String,
    pub detail: Option<String>,
    pub status: Option<RowStatus>,
    #[serde(flatten)]
    pub system: SystemDetail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NonOperationSystemKind {
    Debug,
    Error,
    Reconnect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SystemDetail {
    NonOperation(NonOperationSystemFields),
    ParentChange(ParentChangeOperationFields),
    Operation(GenericOperationFields),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NonOperationSystemFields {
    pub system_kind: NonOperationSystemKind,
}

/// `operation_kind` is never [`SystemOperationKind::ParentChange`] here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericOperationFields {
    pub system_kind: OperationSystemKindTag,
    pub operation_kind: SystemOperationKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_id: Option<String>,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentChangeOperationFields {
    pub system_kind: OperationSystemKindTag,
    pub operation_kind: ParentChangeOperationTag,
    pub parent_change: ParentChange,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DiffStats {
    pub added: u64,
    pub removed: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: Option<String>,
    pub move_path: Option<String>,
    pub diff: Option<String>,
    pub diff_stats: DiffStats,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FullOutputAvailability {
    Available,
    DetailLimit,
    RetentionExpired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutputPreview {
    #[serde(rename = "experimental_fullOutputAvailability")]
    pub full_output_availability: FullOutputAvailability,
    #[serde(rename = "totalChars")]
    pub total_chars: u64,
}

/// A work row: the row base, `kind: "work"`, `status`, then the `workKind`-specific fields.
/// `presentation` fields hold the item's `ThreadEventItemPresentation` JSON unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkRow {
    #[serde(flatten)]
    pub base: RowBase,
    pub kind: WorkTag,
    pub status: RowStatus,
    #[serde(flatten)]
    pub work: WorkDetail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WorkDetail {
    Command(CommandWork),
    Tool(ToolWork),
    FileChange(FileChangeWork),
    WebSearch(WebSearchWork),
    WebFetch(WebFetchWork),
    ImageGeneration(ImageGenerationWork),
    ImageView(ImageViewWork),
    FileRead(FileReadWork),
    Search(SearchWork),
    PlanSteps(PlanStepsWork),
    Extension(ExtensionWork),
    Approval(ApprovalWork),
    Question(QuestionWork),
    Form(FormWork),
    Delegation(DelegationWork),
    Workflow(WorkflowWork),
}

impl WorkDetail {
    /// The `workKind` string.
    pub fn work_kind(&self) -> &'static str {
        match self {
            Self::Command(_) => CommandTag::VALUE,
            Self::Tool(_) => ToolTag::VALUE,
            Self::FileChange(_) => FileChangeTag::VALUE,
            Self::WebSearch(_) => WebSearchTag::VALUE,
            Self::WebFetch(_) => WebFetchTag::VALUE,
            Self::ImageGeneration(_) => ImageGenerationTag::VALUE,
            Self::ImageView(_) => ImageViewTag::VALUE,
            Self::FileRead(_) => FileReadTag::VALUE,
            Self::Search(_) => SearchTag::VALUE,
            Self::PlanSteps(_) => PlanStepsTag::VALUE,
            Self::Extension(_) => ExtensionTag::VALUE,
            Self::Approval(_) => ApprovalTag::VALUE,
            Self::Question(_) => QuestionTag::VALUE,
            Self::Form(_) => FormTag::VALUE,
            Self::Delegation(_) => DelegationTag::VALUE,
            Self::Workflow(_) => WorkflowTag::VALUE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandWork {
    pub work_kind: CommandTag,
    pub call_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub source: Option<String>,
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_preview: Option<OutputPreview>,
    pub exit_code: Option<i64>,
    pub completed_at: Option<i64>,
    pub approval_status: Option<ApprovalStatus>,
    pub activity_intents: Vec<ActivityIntent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

/// `tool_args` is a JSON object or `None`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolWork {
    pub work_kind: ToolTag,
    pub call_id: String,
    pub tool_name: String,
    pub tool_args: Option<serde_json::Map<String, Value>>,
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_preview: Option<OutputPreview>,
    pub completed_at: Option<i64>,
    pub approval_status: Option<ApprovalStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeWork {
    pub work_kind: FileChangeTag,
    pub call_id: String,
    pub change: FileChange,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub approval_status: Option<ApprovalStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchWork {
    pub work_kind: WebSearchTag,
    pub call_id: String,
    pub queries: Vec<String>,
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchWork {
    pub work_kind: WebFetchTag,
    pub call_id: String,
    pub url: String,
    pub prompt: Option<String>,
    pub pattern: Option<String>,
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageViewWork {
    pub work_kind: ImageViewTag,
    pub call_id: String,
    pub path: String,
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationWork {
    pub work_kind: ImageGenerationTag,
    pub call_id: String,
    pub prompt: Option<String>,
    pub path: Option<String>,
    pub error: Option<String>,
    pub transparent_background: bool,
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadWork {
    pub work_kind: FileReadTag,
    pub call_id: String,
    pub path: String,
    pub cmd: Option<String>,
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Content,
    Path,
    List,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWork {
    pub work_kind: SearchTag,
    pub call_id: String,
    pub mode: SearchMode,
    pub query: String,
    pub path: Option<String>,
    pub cmd: Option<String>,
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

/// `steps` are `ThreadEventPlanStep` JSON objects (`{ step, status? }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepsWork {
    pub work_kind: PlanStepsTag,
    pub call_id: String,
    pub steps: Vec<Value>,
    pub explanation: Option<String>,
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionWork {
    pub work_kind: ExtensionTag,
    pub call_id: String,
    pub extension_kind: String,
    pub payload: Value,
    pub completed_at: Option<i64>,
    pub presentation: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalTarget {
    pub item_id: String,
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalWork {
    pub work_kind: ApprovalTag,
    pub interaction_id: String,
    pub target: ApprovalTarget,
    #[serde(flatten)]
    pub approval: ApprovalDetail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ApprovalDetail {
    FileEdit(FileEditApprovalFields),
    PermissionGrant(PermissionGrantApprovalFields),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileEditApprovalLifecycle {
    Waiting,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEditApprovalFields {
    pub approval_kind: FileEditApprovalTag,
    pub lifecycle: FileEditApprovalLifecycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionGrantLifecycle {
    Pending,
    Resolving,
    Granted,
    Denied,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionGrantScope {
    Turn,
    Session,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionGrantApprovalFields {
    pub approval_kind: PermissionGrantApprovalTag,
    pub lifecycle: PermissionGrantLifecycle,
    pub grant_scope: Option<PermissionGrantScope>,
    pub status_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionLifecycle {
    Pending,
    Resolving,
    Answered,
    Interrupted,
}

/// `questions` are `PendingInteractionUserQuestionQuestion` JSON; `answers` is the
/// `Record<string, PendingInteractionUserAnswer>` JSON object or `None`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionWork {
    pub work_kind: QuestionTag,
    pub interaction_id: String,
    pub lifecycle: QuestionLifecycle,
    pub questions: Vec<Value>,
    pub answers: Option<serde_json::Map<String, Value>>,
    pub status_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormLifecycle {
    Pending,
    Submitted,
    Cancelled,
}

/// `payload` is any JSON value; `None` serializes `null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormWork {
    pub work_kind: FormTag,
    pub interaction_id: String,
    pub plugin_id: String,
    pub renderer_id: String,
    pub title: String,
    pub lifecycle: FormLifecycle,
    pub status_reason: Option<String>,
    pub presentation: Value,
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationWork {
    pub work_kind: DelegationTag,
    pub call_id: String,
    pub tool_name: String,
    pub child_ref: Option<String>,
    pub background: bool,
    pub subagent_type: Option<String>,
    pub description: Option<String>,
    pub output: String,
    pub completed_at: Option<i64>,
    pub child_rows: Vec<TimelineRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

/// `task_status` is a `BackgroundTaskStatus` string (`pending`, `running`, `paused`, `completed`,
/// `failed`, `killed`, `stopped`); `workflow` and `usage` are the domain snapshots as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowWork {
    pub work_kind: WorkflowTag,
    pub item_id: String,
    pub task_type: String,
    pub workflow_name: Option<String>,
    pub description: String,
    pub model: Option<String>,
    pub task_status: String,
    pub workflow: Option<Value>,
    pub usage: Option<Value>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
}

/// `base.turn_id` is always `Some` for a turn row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRow {
    #[serde(flatten)]
    pub base: RowBase,
    pub kind: TurnTag,
    pub status: RowStatus,
    pub summary_count: u64,
    pub completed_at: Option<i64>,
    pub children: Option<Vec<TimelineRow>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TimelineRow {
    Conversation(ConversationRow),
    Work(WorkRow),
    System(SystemRow),
    Turn(TurnRow),
}

impl TimelineRow {
    pub fn base(&self) -> &RowBase {
        match self {
            Self::Conversation(row) => &row.base,
            Self::Work(row) => &row.base,
            Self::System(row) => &row.base,
            Self::Turn(row) => &row.base,
        }
    }

    pub fn base_mut(&mut self) -> &mut RowBase {
        match self {
            Self::Conversation(row) => &mut row.base,
            Self::Work(row) => &mut row.base,
            Self::System(row) => &mut row.base,
            Self::Turn(row) => &mut row.base,
        }
    }

    pub fn id(&self) -> &str {
        &self.base().id
    }

    /// The `kind` string: `conversation`, `work`, `system` or `turn`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Conversation(_) => ConversationTag::VALUE,
            Self::Work(_) => WorkTag::VALUE,
            Self::System(_) => SystemTag::VALUE,
            Self::Turn(_) => TurnTag::VALUE,
        }
    }
}

impl From<ConversationRow> for TimelineRow {
    fn from(row: ConversationRow) -> Self {
        Self::Conversation(row)
    }
}

impl From<WorkRow> for TimelineRow {
    fn from(row: WorkRow) -> Self {
        Self::Work(row)
    }
}

impl From<SystemRow> for TimelineRow {
    fn from(row: SystemRow) -> Self {
        Self::System(row)
    }
}

impl From<TurnRow> for TimelineRow {
    fn from(row: TurnRow) -> Self {
        Self::Turn(row)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDelta {
    pub upsert_rows: Vec<TimelineRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_order: Option<Vec<String>>,
}

fn row_json(row: &TimelineRow) -> String {
    serde_json::to_string(row).unwrap_or_default()
}

pub fn compute_timeline_row_delta(
    prev_rows: &[TimelineRow],
    current_rows: &[TimelineRow],
) -> TimelineDelta {
    let prev_by_id: std::collections::HashMap<&str, String> =
        prev_rows.iter().map(|row| (row.id(), row_json(row))).collect();
    let mut upsert_rows = Vec::new();
    let mut row_order = Vec::with_capacity(current_rows.len());
    let mut order_changed = prev_rows.len() != current_rows.len();
    for (index, row) in current_rows.iter().enumerate() {
        row_order.push(row.id().to_string());
        if prev_rows.get(index).map(TimelineRow::id) != Some(row.id()) {
            order_changed = true;
        }
        if prev_by_id.get(row.id()) != Some(&row_json(row)) {
            upsert_rows.push(row.clone());
        }
    }
    TimelineDelta { upsert_rows, row_order: order_changed.then_some(row_order) }
}

pub fn apply_timeline_delta(
    prev_rows: &[TimelineRow],
    delta: &TimelineDelta,
) -> Option<Vec<TimelineRow>> {
    let mut by_id: std::collections::HashMap<&str, &TimelineRow> =
        prev_rows.iter().map(|row| (row.id(), row)).collect();
    for row in &delta.upsert_rows {
        by_id.insert(row.id(), row);
    }
    let fallback_order: Vec<String>;
    let row_order = match &delta.row_order {
        Some(order) => order,
        None => {
            fallback_order = prev_rows.iter().map(|row| row.id().to_string()).collect();
            &fallback_order
        }
    };
    row_order.iter().map(|id| by_id.get(id.as_str()).map(|row| (*row).clone())).collect()
}
