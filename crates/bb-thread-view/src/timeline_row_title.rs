//! Port of `packages/thread-view/src/timeline-row-title.ts`: the one-line title of a timeline view
//! row (segments with emphasis/links, decorations, an optional action) and its plain-text render.
//! The web-only glyph/presentation exports and `buildTimelineActivityIntentTitles` are not ported.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::format::{
    PathDisplayMode, duration_to_compact_string, file_name_from_path, file_read_activity_intent,
    format_diff_stats_text, format_file_change_path, format_timeline_activity_intent_detail_parts,
    get_file_change_action, js_trim, ownership_change_verb, search_activity_intent,
};
use crate::rows::{
    ActivityIntent, ApprovalDetail, ApprovalStatus, ApprovalWork, CommandWork, ConversationRole,
    FileChangeWork, FileEditApprovalLifecycle, FormLifecycle, FormWork, NonOperationSystemKind,
    ParentChangeAction, ParentChangeOperationFields, PermissionGrantLifecycle,
    PermissionGrantScope, PlanStepsWork, QuestionLifecycle, QuestionWork, RowStatus, SearchMode,
    SearchWork, SystemDetail, SystemOperationKind, SystemRow, ToolWork, TurnRow, WorkDetail,
    WorkRow,
};
use crate::timeline_view::{
    SummaryKind, ViewRow, WorkSummaryRow, build_timeline_work_summary_label,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineTitleTone {
    Default,
    Summary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TimelineTitleLink {
    Thread {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineTitleSegmentAccent {
    Muted,
    Subtle,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTitleSegment {
    pub text: String,
    pub em: bool,
    pub shimmer: bool,
    pub truncate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plain_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<TimelineTitleLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<TimelineTitleSegmentAccent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TimelineStatusDecorationStatus {
    Denied,
    Error,
    Interrupted,
}

impl TimelineStatusDecorationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Denied => "denied",
            Self::Error => "error",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum TimelineTitleDecoration {
    Duration {
        started_at: i64,
        completed_at: Option<i64>,
        em: bool,
    },
    Status {
        status: TimelineStatusDecorationStatus,
        duration_ms: Option<i64>,
        emphasis: bool,
    },
    SummaryStatus {
        error_count: u64,
        interrupted_count: u64,
    },
    DiffStats {
        added: u64,
        removed: u64,
    },
    /// `tone` is `"neutral" | "destructive"`, copied from the row presentation.
    Badge {
        glyph: String,
        label: String,
        hint: String,
        tone: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TimelineTitleAction {
    OpenFileDiff { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TimelineTitle {
    pub segments: Vec<TimelineTitleSegment>,
    pub decorations: Vec<TimelineTitleDecoration>,
    pub tone: TimelineTitleTone,
    pub action: Option<TimelineTitleAction>,
    pub plain: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleSummaryStyle {
    Bundle,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleWorkStyle {
    Default,
    Summary,
}

/// `BuildTimelineRowTitleOptions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTitleOptions {
    pub summary_style: TitleSummaryStyle,
    pub work_style: TitleWorkStyle,
    #[serde(default)]
    pub is_active_latest_bundle: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DisplayStatus {
    Waiting,
    Denied,
    Row(RowStatus),
}

#[derive(Debug, Clone, Copy)]
struct Timed {
    started_at: i64,
    completed_at: Option<i64>,
}

fn collapse_title_newlines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_break = false;
    for c in text.chars() {
        if c == '\r' || c == '\n' {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            out.push(c);
            in_break = false;
        }
    }
    out
}

fn segment(text: &str) -> TimelineTitleSegment {
    TimelineTitleSegment {
        text: collapse_title_newlines(text),
        em: false,
        shimmer: false,
        truncate: false,
        plain_text: None,
        link: None,
        accent: None,
    }
}

impl TimelineTitleSegment {
    fn em(mut self) -> Self {
        self.em = true;
        self
    }
    fn shimmer(mut self, shimmer: bool) -> Self {
        self.shimmer = shimmer;
        self
    }
    fn truncate(mut self) -> Self {
        self.truncate = true;
        self
    }
    fn plain(mut self, plain: &str) -> Self {
        self.plain_text = Some(collapse_title_newlines(plain));
        self
    }
    fn accent(mut self, accent: Option<TimelineTitleSegmentAccent>) -> Self {
        self.accent = accent;
        self
    }
    fn link(mut self, thread_id: &str) -> Self {
        self.link = Some(TimelineTitleLink::Thread { thread_id: thread_id.to_string() });
        self
    }
}

fn emphasized(text: &str) -> TimelineTitleSegment {
    segment(text).em().truncate()
}

type StatusVerbs = [&'static str; 4];

fn verb_segment(verbs: &StatusVerbs, status: RowStatus) -> TimelineTitleSegment {
    let index = match status {
        RowStatus::Pending => 0,
        RowStatus::Completed => 1,
        RowStatus::Error => 2,
        RowStatus::Interrupted => 3,
    };
    segment(verbs[index]).shimmer(status == RowStatus::Pending)
}

fn visible_duration_ms(duration_ms: Option<i64>) -> Option<i64> {
    duration_ms.filter(|ms| *ms > 1_000)
}

fn elapsed_ms(row: Timed) -> Option<i64> {
    row.completed_at.map(|completed| completed - row.started_at)
}

fn duration_decorations(row: Timed, em: bool) -> Vec<TimelineTitleDecoration> {
    if visible_duration_ms(elapsed_ms(row)).is_none() && row.completed_at.is_some() {
        return Vec::new();
    }
    vec![TimelineTitleDecoration::Duration {
        started_at: row.started_at,
        completed_at: row.completed_at,
        em,
    }]
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn badge_decorations(presentation: Option<&Value>) -> Vec<TimelineTitleDecoration> {
    let Some(badge) = presentation.and_then(|p| p.get("badge")).filter(|b| b.is_object()) else {
        return Vec::new();
    };
    let text = |key: &str| str_field(badge, key).unwrap_or_default().to_string();
    vec![TimelineTitleDecoration::Badge {
        glyph: text("glyph"),
        label: text("label"),
        hint: text("hint"),
        tone: text("tone"),
    }]
}

fn status_decoration(
    status: TimelineStatusDecorationStatus,
    duration_ms: Option<i64>,
    emphasis: bool,
) -> TimelineTitleDecoration {
    TimelineTitleDecoration::Status {
        status,
        duration_ms: visible_duration_ms(duration_ms),
        emphasis,
    }
}

fn failure_status(status: RowStatus) -> Option<TimelineStatusDecorationStatus> {
    match status {
        RowStatus::Error => Some(TimelineStatusDecorationStatus::Error),
        RowStatus::Interrupted => Some(TimelineStatusDecorationStatus::Interrupted),
        _ => None,
    }
}

fn settled_decorations(status: DisplayStatus, row: Timed) -> Vec<TimelineTitleDecoration> {
    match status {
        DisplayStatus::Row(status) => match failure_status(status) {
            Some(failure) => vec![status_decoration(failure, elapsed_ms(row), false)],
            None => duration_decorations(row, false),
        },
        _ => duration_decorations(row, false),
    }
}

fn summary_status_decoration(row: &WorkSummaryRow) -> Option<TimelineTitleDecoration> {
    let mut error_count = 0;
    let mut interrupted_count = 0;
    for child in &row.children {
        match child.status() {
            RowStatus::Error => error_count += 1,
            RowStatus::Interrupted => interrupted_count += 1,
            _ => {}
        }
    }
    if error_count == 0 && interrupted_count == 0 {
        return None;
    }
    Some(TimelineTitleDecoration::SummaryStatus { error_count, interrupted_count })
}

/// `formatTimelineDecorationText`.
pub fn format_timeline_decoration_text(decoration: &TimelineTitleDecoration) -> String {
    match decoration {
        TimelineTitleDecoration::Duration { started_at, completed_at, .. } => match completed_at {
            None => String::new(),
            Some(completed) => {
                format!("({})", duration_to_compact_string((completed - started_at) as f64))
            }
        },
        TimelineTitleDecoration::Status { status, duration_ms, .. } => match duration_ms {
            Some(ms) => {
                format!("({}, {})", duration_to_compact_string(*ms as f64), status.as_str())
            }
            None => format!("({})", status.as_str()),
        },
        TimelineTitleDecoration::SummaryStatus { error_count, interrupted_count } => {
            let mut parts = Vec::new();
            if *error_count > 0 {
                parts.push(format!(
                    "{error_count} error{}",
                    if *error_count > 1 { "s" } else { "" }
                ));
            }
            if *interrupted_count > 0 {
                parts.push(format!("{interrupted_count} interrupted"));
            }
            if parts.is_empty() { String::new() } else { format!("({})", parts.join(", ")) }
        }
        TimelineTitleDecoration::DiffStats { added, removed } => {
            format_diff_stats_text(*added as i64, *removed as i64, true)
        }
        TimelineTitleDecoration::Badge { label, .. } => format!("({label})"),
    }
}

/// `renderTitlePlain`.
pub fn render_title_plain(
    segments: &[TimelineTitleSegment],
    decorations: &[TimelineTitleDecoration],
) -> String {
    let segments_text = segments
        .iter()
        .map(|s| s.plain_text.as_deref().unwrap_or(&s.text))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let decorations_text = decorations
        .iter()
        .map(format_timeline_decoration_text)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if decorations_text.is_empty() {
        return segments_text;
    }
    if segments_text.is_empty() {
        return decorations_text;
    }
    format!("{segments_text} {decorations_text}")
}

fn make_title_full(
    segments: Vec<TimelineTitleSegment>,
    decorations: Vec<TimelineTitleDecoration>,
    action: Option<TimelineTitleAction>,
    tone: TimelineTitleTone,
) -> TimelineTitle {
    let plain = render_title_plain(&segments, &decorations);
    TimelineTitle { segments, decorations, tone, action, plain }
}

fn make_title(
    segments: Vec<TimelineTitleSegment>,
    decorations: Vec<TimelineTitleDecoration>,
) -> TimelineTitle {
    make_title_full(segments, decorations, None, TimelineTitleTone::Default)
}

fn display_status(approval: Option<ApprovalStatus>, status: RowStatus) -> DisplayStatus {
    match approval {
        Some(ApprovalStatus::WaitingForApproval) => DisplayStatus::Waiting,
        Some(ApprovalStatus::Denied) => DisplayStatus::Denied,
        None => DisplayStatus::Row(status),
    }
}

fn approval_lead(waiting: bool, purpose: &str) -> Vec<TimelineTitleSegment> {
    if waiting {
        vec![segment("Waiting for approval").shimmer(true), segment(purpose)]
    } else {
        vec![segment("Permission denied:")]
    }
}

fn presented_title(
    presentation: &Value,
    status: RowStatus,
    row: Timed,
    content: Option<&str>,
    plain_content: Option<&str>,
    em: bool,
) -> TimelineTitle {
    let pending = status == RowStatus::Pending;
    let content = content.filter(|c| !c.is_empty());
    let label = presentation.get("label").unwrap_or(&Value::Null);
    let lead = str_field(label, if pending { "pending" } else { "completed" }).unwrap_or_default();
    let mut lead = segment(lead).shimmer(pending);
    lead.truncate = content.is_none();
    let mut segments = vec![lead];
    if let Some(content) = content {
        let mut seg = segment(content).truncate();
        seg.em = em;
        if let Some(plain) = plain_content {
            seg = seg.plain(plain);
        }
        segments.push(seg);
    }
    let mut decorations = badge_decorations(Some(presentation));
    decorations.extend(settled_decorations(DisplayStatus::Row(status), row));
    make_title(segments, decorations)
}

fn presentation_title(presentation: &Value) -> Option<&str> {
    str_field(presentation, "title")
}

/// `formatToolCallCommand` from `@bb/domain` (same as the copy in `bb-server`'s `event_read.rs`,
/// which this crate cannot depend on).
fn format_tool_call_command(tool: &str, args: Option<&Map<String, Value>>) -> String {
    let Some(args) = args.filter(|args| !args.is_empty()) else { return tool.to_string() };
    let compact: Vec<String> = args
        .iter()
        .map(|(key, value)| {
            let text = match value {
                Value::String(text) => js_trim(text).to_string(),
                other => other.to_string(),
            };
            let units: Vec<u16> = text.encode_utf16().collect();
            let display = if units.len() > 40 {
                format!("{}...", String::from_utf16_lossy(&units[..37]))
            } else {
                text
            };
            format!("{key}: {display}")
        })
        .collect();
    format!("{tool} {{ {} }}", compact.join(", "))
}

enum Execution<'a> {
    Command(&'a CommandWork),
    Tool(&'a ToolWork),
}

fn map_execution_title(row: &WorkRow, work: Execution<'_>) -> TimelineTitle {
    let (approval, presentation, completed_at) = match work {
        Execution::Command(c) => (c.approval_status, c.presentation.as_ref(), c.completed_at),
        Execution::Tool(t) => (t.approval_status, t.presentation.as_ref(), t.completed_at),
    };
    let timed = Timed { started_at: row.base.started_at, completed_at };
    let status = display_status(approval, row.status);
    let is_command = matches!(work, Execution::Command(_));
    if let (Some(presentation), DisplayStatus::Row(_), false) = (presentation, status, is_command) {
        return presented_title(
            presentation,
            row.status,
            timed,
            presentation_title(presentation),
            None,
            true,
        );
    }
    if let Execution::Command(command) = work
        && let Some(title) = map_single_exploration_intent_title(row, command)
    {
        return title;
    }
    let content = emphasized(&match work {
        Execution::Command(c) => c.command.clone(),
        Execution::Tool(t) => format_tool_call_command(&t.tool_name, t.tool_args.as_ref()),
    });
    let mut decorations = badge_decorations(presentation);
    let mut lead = match status {
        DisplayStatus::Waiting => {
            let mut segments = approval_lead(true, if is_command { "to run" } else { "to use" });
            segments.push(content);
            return make_title(segments, decorations);
        }
        DisplayStatus::Denied => approval_lead(false, ""),
        DisplayStatus::Row(RowStatus::Pending) => {
            vec![segment(if is_command { "Running" } else { "Running tool:" }).shimmer(true)]
        }
        DisplayStatus::Row(_) => vec![segment(if is_command { "Ran" } else { "Ran tool" })],
    };
    lead.push(content);
    decorations.extend(settled_decorations(status, timed));
    make_title(lead, decorations)
}

fn joined_intent_detail(intent: &ActivityIntent, mode: PathDisplayMode) -> String {
    let parts = format_timeline_activity_intent_detail_parts(intent, mode, false);
    match parts.prefix.filter(|p| !p.is_empty()) {
        Some(prefix) => format!("{prefix} {}", parts.content),
        None => parts.content,
    }
}

fn map_timeline_activity_intent_title(
    intent: &ActivityIntent,
    pending: bool,
    failure: Option<TimelineStatusDecorationStatus>,
    mut badges: Vec<TimelineTitleDecoration>,
) -> TimelineTitle {
    let detail =
        format_timeline_activity_intent_detail_parts(intent, PathDisplayMode::Compact, pending);
    let plain_content =
        format_timeline_activity_intent_detail_parts(intent, PathDisplayMode::Full, pending)
            .content;
    let mut segments = Vec::new();
    if let Some(prefix) = detail.prefix.filter(|p| !p.is_empty()) {
        segments.push(segment(prefix).shimmer(pending));
    }
    segments.push(segment(&detail.content).truncate().plain(&plain_content));
    if let Some(failure) = failure {
        badges.push(status_decoration(failure, None, false));
    }
    make_title(segments, badges)
}

fn exploration_intent_title(
    row: &WorkRow,
    approval: Option<ApprovalStatus>,
    presentation: Option<&Value>,
    intent: &ActivityIntent,
) -> TimelineTitle {
    let status = display_status(approval, row.status);
    let badges = badge_decorations(presentation);
    match status {
        DisplayStatus::Waiting | DisplayStatus::Denied => {
            let subject = segment(&joined_intent_detail(intent, PathDisplayMode::Compact))
                .em()
                .truncate()
                .plain(&joined_intent_detail(intent, PathDisplayMode::Full));
            let mut segments = approval_lead(status == DisplayStatus::Waiting, "to use");
            segments.push(subject);
            make_title(segments, badges)
        }
        DisplayStatus::Row(status) => map_timeline_activity_intent_title(
            intent,
            status == RowStatus::Pending,
            failure_status(status),
            badges,
        ),
    }
}

fn map_single_exploration_intent_title(
    row: &WorkRow,
    command: &CommandWork,
) -> Option<TimelineTitle> {
    let mut known = command.activity_intents.iter().filter(|i| !i.is_unknown());
    let intent = known.next()?;
    if known.next().is_some() {
        return None;
    }
    Some(exploration_intent_title(
        row,
        command.approval_status,
        command.presentation.as_ref(),
        intent,
    ))
}

fn map_file_change_title(row: &WorkRow, work: &FileChangeWork) -> TimelineTitle {
    let status = display_status(work.approval_status, row.status);
    let change = (&work.change).into();
    let action = get_file_change_action(&change);
    let path_segment = segment(&format_file_change_path(&change, PathDisplayMode::Compact))
        .em()
        .truncate()
        .plain(&format_file_change_path(&change, PathDisplayMode::Full))
        .accent(Some(TimelineTitleSegmentAccent::File));
    let mut segments = match status {
        DisplayStatus::Waiting => approval_lead(true, "to edit"),
        DisplayStatus::Denied => approval_lead(false, "to edit"),
        DisplayStatus::Row(RowStatus::Pending) => vec![segment(action.present()).shimmer(true)],
        DisplayStatus::Row(RowStatus::Completed) => vec![segment(action.past())],
        DisplayStatus::Row(RowStatus::Error) => {
            vec![segment(&format!("Failed to {}", action.infinitive()))]
        }
        DisplayStatus::Row(RowStatus::Interrupted) => {
            vec![segment(&format!("Interrupted while {}", action.present().to_lowercase()))]
        }
    };
    segments.push(path_segment);
    let decorations = match status {
        DisplayStatus::Row(RowStatus::Error) => {
            vec![status_decoration(TimelineStatusDecorationStatus::Error, None, false)]
        }
        DisplayStatus::Row(RowStatus::Interrupted) => Vec::new(),
        _ => {
            let stats = work.change.diff_stats;
            if stats.added == 0 && stats.removed == 0 {
                Vec::new()
            } else {
                vec![TimelineTitleDecoration::DiffStats {
                    added: stats.added,
                    removed: stats.removed,
                }]
            }
        }
    };
    let path = work.change.move_path.clone().unwrap_or_else(|| work.change.path.clone());
    make_title_full(
        segments,
        decorations,
        Some(TimelineTitleAction::OpenFileDiff { path }),
        TimelineTitleTone::Default,
    )
}

const WEB_SEARCH_VERBS: StatusVerbs =
    ["Running web search:", "Ran web search:", "Ran web search:", "Interrupted web search:"];
const WEB_FETCH_VERBS: StatusVerbs = ["Fetching:", "Fetched:", "Fetched:", "Interrupted fetch:"];
const IMAGE_VIEW_VERBS: StatusVerbs =
    ["Viewing image:", "Viewed image:", "Viewed image:", "Interrupted image view:"];
const IMAGE_GENERATION_LABELS: StatusVerbs = [
    "Generating image",
    "Generated image",
    "Image generation failed",
    "Interrupted image generation",
];
const DELEGATION_VERBS: StatusVerbs =
    ["Running subagent:", "Ran subagent:", "Failed subagent:", "Interrupted subagent:"];
const WORKFLOW_VERBS: StatusVerbs =
    ["Running workflow:", "Ran workflow:", "Failed workflow:", "Interrupted workflow:"];
const BACKGROUND_COMMAND_VERBS: StatusVerbs = [
    "Running background command:",
    "Ran background command:",
    "Background command failed:",
    "Background command interrupted:",
];
const BACKGROUND_AGENT_VERBS: StatusVerbs = [
    "Running background agent:",
    "Ran background agent:",
    "Background agent failed:",
    "Background agent interrupted:",
];

fn map_web_activity_title(
    status: RowStatus,
    row: Timed,
    verbs: &StatusVerbs,
    subject: &str,
    plain: Option<&str>,
) -> TimelineTitle {
    let mut subject = segment(subject).truncate();
    if let Some(plain) = plain {
        subject = subject.plain(plain);
    }
    make_title(
        vec![verb_segment(verbs, status), subject],
        if status == RowStatus::Pending {
            Vec::new()
        } else {
            settled_decorations(DisplayStatus::Row(status), row)
        },
    )
}

fn map_question_title(work: &QuestionWork) -> TimelineTitle {
    let question = if work.questions.len() == 1 { work.questions.first() } else { None };
    let subject = match question {
        Some(q) => emphasized(str_field(q, "prompt").unwrap_or_default()),
        None => segment(&format!("{} questions", work.questions.len())).em(),
    };
    match work.lifecycle {
        QuestionLifecycle::Pending | QuestionLifecycle::Resolving => {
            let verb = if work.lifecycle == QuestionLifecycle::Pending {
                "Waiting for"
            } else {
                "Delivering"
            };
            let lead = if question.is_some() {
                format!("{verb} answer")
            } else {
                format!("{verb} answers to")
            };
            make_title(vec![segment(&lead).shimmer(true), subject], Vec::new())
        }
        QuestionLifecycle::Answered => {
            let mut segments = vec![segment("Answered"), subject];
            if let Some(summary) = question.and_then(|q| single_question_answer_summary(work, q)) {
                segments.push(segment(&format!("— {summary}")).truncate());
            }
            make_title(segments, Vec::new())
        }
        QuestionLifecycle::Interrupted => make_title(
            vec![segment("Asked"), subject],
            vec![status_decoration(TimelineStatusDecorationStatus::Interrupted, None, false)],
        ),
    }
}

fn single_question_answer_summary(work: &QuestionWork, question: &Value) -> Option<String> {
    let id = str_field(question, "id")?;
    let answer = work.answers.as_ref()?.get(id).filter(|a| a.is_object())?;
    let options = question.get("options").and_then(Value::as_array);
    let mut parts: Vec<String> = answer
        .get("selected")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|value| {
            let value = value.as_str().unwrap_or_default();
            options
                .and_then(|opts| opts.iter().find(|o| str_field(o, "value") == Some(value)))
                .and_then(|o| str_field(o, "label"))
                .unwrap_or(value)
                .to_string()
        })
        .collect();
    if let Some(free) = str_field(answer, "freeText").filter(|f| !f.is_empty()) {
        parts.push(free.to_string());
    }
    let text = parts.join(", ");
    (!text.is_empty()).then_some(text)
}

fn map_approval_title(work: &ApprovalWork) -> TimelineTitle {
    let grant = match &work.approval {
        ApprovalDetail::FileEdit(fields) => {
            let segments = match fields.lifecycle {
                FileEditApprovalLifecycle::Waiting => {
                    vec![segment("Waiting for approval to edit").shimmer(true), emphasized("files")]
                }
                FileEditApprovalLifecycle::Denied => {
                    vec![segment("Permission denied:"), emphasized("file changes")]
                }
            };
            return make_title(segments, Vec::new());
        }
        ApprovalDetail::PermissionGrant(grant) => grant,
    };
    let tool = work.target.tool_name.as_deref().map(emphasized);
    let with_tool = |lead: TimelineTitleSegment, rest: Vec<TimelineTitleSegment>| {
        let mut segments = vec![lead];
        segments.extend(rest);
        make_title(segments, Vec::new())
    };
    match grant.lifecycle {
        PermissionGrantLifecycle::Pending | PermissionGrantLifecycle::Resolving => {
            let verb = if grant.lifecycle == PermissionGrantLifecycle::Pending {
                "Waiting for"
            } else {
                "Delivering"
            };
            match tool {
                Some(tool) => with_tool(
                    segment(&format!("{verb} permission")).shimmer(true),
                    vec![segment("to use"), tool],
                ),
                None => {
                    with_tool(segment(&format!("{verb} permissions")).shimmer(true), Vec::new())
                }
            }
        }
        PermissionGrantLifecycle::Granted => {
            let granted = match grant.grant_scope {
                Some(PermissionGrantScope::Turn) => "Permission granted for this turn",
                Some(PermissionGrantScope::Session) => "Permission granted for this session",
                _ => "Permission granted",
            };
            match tool {
                Some(tool) => with_tool(segment(&format!("{granted}:")), vec![tool]),
                None => with_tool(segment(granted), Vec::new()),
            }
        }
        PermissionGrantLifecycle::Denied => match tool {
            Some(tool) => with_tool(segment("Permission denied:"), vec![tool]),
            None => with_tool(segment("Permission denied"), Vec::new()),
        },
        PermissionGrantLifecycle::Interrupted => {
            let reason = grant.status_reason.as_deref().map(js_trim).filter(|r| !r.is_empty());
            let lead = segment(if tool.is_some() {
                "Permission grant interrupted:"
            } else {
                "Permission grant interrupted"
            });
            let mut rest: Vec<TimelineTitleSegment> = tool.into_iter().collect();
            if let Some(reason) = reason {
                rest.push(segment(&format!("({reason})")).truncate());
            }
            with_tool(lead, rest)
        }
    }
}

fn map_form_title(work: &FormWork) -> TimelineTitle {
    let presentation = &work.presentation;
    let label = presentation.get("label").unwrap_or(&Value::Null);
    let pending = str_field(label, "pending").unwrap_or_default();
    let completed = str_field(label, "completed").unwrap_or_default();
    match work.lifecycle {
        FormLifecycle::Pending => make_title(vec![segment(pending).shimmer(true)], Vec::new()),
        FormLifecycle::Submitted => make_title(
            vec![segment(presentation_title(presentation).unwrap_or(completed)).truncate()],
            Vec::new(),
        ),
        FormLifecycle::Cancelled => make_title(
            vec![segment(completed).truncate()],
            vec![status_decoration(TimelineStatusDecorationStatus::Interrupted, None, false)],
        ),
    }
}

fn search_content(work: &SearchWork) -> String {
    let path = work.path.as_deref().filter(|p| !p.is_empty());
    let root = path.map(|p| format!(" in {p}")).unwrap_or_default();
    match work.mode {
        SearchMode::Content => format!("for {}{root}", work.query),
        SearchMode::Path => format!("matching {}{root}", work.query),
        SearchMode::List => match path {
            Some(p) => format!("in {p}"),
            None if !work.query.is_empty() => format!("in {}", work.query),
            None => String::new(),
        },
    }
}

fn map_plan_steps_title(row: &WorkRow, work: &PlanStepsWork, timed: Timed) -> TimelineTitle {
    let content = work
        .steps
        .iter()
        .find(|step| str_field(step, "status") == Some("active"))
        .and_then(|step| str_field(step, "step"))
        .or(work.explanation.as_deref());
    if let Some(presentation) = &work.presentation {
        let content = presentation_title(presentation).or(content);
        return presented_title(presentation, row.status, timed, content, None, false);
    }
    let completed =
        work.steps.iter().filter(|s| str_field(s, "status") == Some("completed")).count();
    let pending = row.status == RowStatus::Pending;
    let content = content
        .map(str::to_string)
        .unwrap_or_else(|| format!("{completed}/{} steps done", work.steps.len()));
    make_title(
        vec![
            segment(if pending { "Updating plan" } else { "Updated plan" }).shimmer(pending),
            segment(&content).truncate(),
        ],
        duration_decorations(timed, false),
    )
}

fn is_settled_workflow_agent_state(state: &str) -> bool {
    matches!(state, "done" | "failed" | "skipped")
}

fn map_work_title(row: &WorkRow) -> TimelineTitle {
    let started_at = row.base.started_at;
    let timed = |completed_at: Option<i64>| Timed { started_at, completed_at };
    let status = row.status;
    match &row.work {
        WorkDetail::Command(c) => map_execution_title(row, Execution::Command(c)),
        WorkDetail::Tool(t) => map_execution_title(row, Execution::Tool(t)),
        WorkDetail::FileRead(w) => match &w.presentation {
            Some(p) => presented_title(
                p,
                status,
                timed(w.completed_at),
                Some(&file_name_from_path(&w.path)),
                Some(&w.path),
                true,
            ),
            None => exploration_intent_title(row, None, None, &file_read_activity_intent(w)),
        },
        WorkDetail::Search(w) => match &w.presentation {
            Some(p) => presented_title(
                p,
                status,
                timed(w.completed_at),
                Some(&search_content(w)),
                None,
                false,
            ),
            None => exploration_intent_title(row, None, None, &search_activity_intent(w)),
        },
        WorkDetail::PlanSteps(w) => map_plan_steps_title(row, w, timed(w.completed_at)),
        WorkDetail::Extension(w) => presented_title(
            &w.presentation,
            status,
            timed(w.completed_at),
            presentation_title(&w.presentation),
            None,
            false,
        ),
        WorkDetail::FileChange(w) => map_file_change_title(row, w),
        WorkDetail::WebSearch(w) => {
            let queries = w.queries.join(", ");
            match &w.presentation {
                Some(p) => {
                    presented_title(p, status, timed(w.completed_at), Some(&queries), None, false)
                }
                None => map_web_activity_title(
                    status,
                    timed(w.completed_at),
                    &WEB_SEARCH_VERBS,
                    if queries.is_empty() { "web search" } else { &queries },
                    None,
                ),
            }
        }
        WorkDetail::WebFetch(w) => match &w.presentation {
            Some(p) => presented_title(p, status, timed(w.completed_at), Some(&w.url), None, false),
            None => map_web_activity_title(
                status,
                timed(w.completed_at),
                &WEB_FETCH_VERBS,
                &w.url,
                None,
            ),
        },
        WorkDetail::ImageGeneration(w) => match &w.presentation {
            Some(p) => {
                presented_title(p, status, timed(w.completed_at), presentation_title(p), None, true)
            }
            None => make_title(
                vec![verb_segment(&IMAGE_GENERATION_LABELS, status)],
                match failure_status(status) {
                    Some(failure) => vec![status_decoration(failure, None, false)],
                    None => duration_decorations(timed(w.completed_at), false),
                },
            ),
        },
        WorkDetail::ImageView(w) => {
            let name = file_name_from_path(&w.path);
            match &w.presentation {
                Some(p) => presented_title(
                    p,
                    status,
                    timed(w.completed_at),
                    Some(&name),
                    Some(&w.path),
                    true,
                ),
                None => map_web_activity_title(
                    status,
                    timed(w.completed_at),
                    &IMAGE_VIEW_VERBS,
                    &name,
                    Some(&w.path),
                ),
            }
        }
        WorkDetail::Delegation(w) => {
            let trimmed = js_trim(&w.output);
            let description = w.description.as_deref().unwrap_or(if trimmed.is_empty() {
                &w.tool_name
            } else {
                trimmed
            });
            if let Some(p) = &w.presentation {
                return presented_title(
                    p,
                    status,
                    timed(w.completed_at),
                    Some(description),
                    None,
                    true,
                );
            }
            let mut segments =
                vec![verb_segment(&DELEGATION_VERBS, status), emphasized(description)];
            if let Some(kind) = w.subagent_type.as_deref().filter(|k| !k.is_empty()) {
                segments.push(segment(&format!("({kind})")).truncate());
            }
            make_title(segments, duration_decorations(timed(w.completed_at), false))
        }
        WorkDetail::Workflow(w) => {
            let verbs = if is_background_command_task_type(&w.task_type) {
                &BACKGROUND_COMMAND_VERBS
            } else if is_background_agent_task_type(&w.task_type) {
                &BACKGROUND_AGENT_VERBS
            } else {
                &WORKFLOW_VERBS
            };
            let is_workflow = std::ptr::eq(verbs, &WORKFLOW_VERBS);
            let subject = if is_workflow {
                w.workflow_name.as_deref().unwrap_or(&w.description)
            } else {
                &w.description
            };
            let mut segments = vec![verb_segment(verbs, status), emphasized(subject)];
            let agents = if is_workflow {
                w.workflow.as_ref().and_then(|wf| wf.get("agents")).and_then(Value::as_array)
            } else {
                None
            };
            if let Some(agents) = agents.filter(|a| !a.is_empty()) {
                let done = agents
                    .iter()
                    .filter(|a| str_field(a, "state").is_some_and(is_settled_workflow_agent_state))
                    .count();
                segments.push(segment(&format!("({done}/{} agents)", agents.len())));
            }
            make_title(segments, duration_decorations(timed(w.completed_at), false))
        }
        WorkDetail::Approval(w) => map_approval_title(w),
        WorkDetail::Question(w) => map_question_title(w),
        WorkDetail::Form(w) => map_form_title(w),
    }
}

fn map_work_summary_title(row: &WorkSummaryRow, options: &TimelineTitleOptions) -> TimelineTitle {
    let is_active = row.kind == SummaryKind::BundleSummary && options.is_active_latest_bundle;
    let label = build_timeline_work_summary_label(row, is_active);
    let (verb, rest) = label.split_once(' ').unwrap_or((&label, ""));
    let decorations: Vec<_> = summary_status_decoration(row).into_iter().collect();
    if options.summary_style == TitleSummaryStyle::Background {
        let text = if rest.is_empty() { verb.to_string() } else { format!("{verb} {rest}") };
        return make_title_full(
            vec![segment(&text).truncate()],
            decorations,
            None,
            TimelineTitleTone::Summary,
        );
    }
    let accent = (!is_active).then_some(TimelineTitleSegmentAccent::Subtle);
    let lead = segment(verb).shimmer(is_active).accent(accent);
    if rest.is_empty() {
        return make_title(vec![lead.truncate()], decorations);
    }
    make_title(vec![lead, segment(rest).em().truncate().accent(accent)], decorations)
}

fn map_turn_title(row: &TurnRow) -> TimelineTitle {
    let timed = Timed { started_at: row.base.started_at, completed_at: row.completed_at };
    if row.status == RowStatus::Pending {
        return make_title(
            vec![segment("Working").shimmer(true)],
            duration_decorations(timed, true),
        );
    }
    match row.completed_at {
        None => make_title(
            vec![segment("Worked").accent(Some(TimelineTitleSegmentAccent::Subtle))],
            Vec::new(),
        ),
        Some(completed_at) => make_title(
            vec![segment("Worked for").accent(Some(TimelineTitleSegmentAccent::Subtle))],
            vec![TimelineTitleDecoration::Duration {
                started_at: row.base.started_at,
                completed_at: Some(completed_at),
                em: false,
            }],
        ),
    }
}

fn parent_change_parent_segment(
    thread_id: Option<&str>,
    title: Option<&str>,
) -> TimelineTitleSegment {
    match thread_id {
        None => segment("parent"),
        Some(id) => segment(title.unwrap_or(id)).em().truncate().link(id),
    }
}

fn parent_change_thread_name(row: &SystemRow, fields: &ParentChangeOperationFields) -> String {
    let change = &fields.parent_change;
    let verb = ownership_change_verb(change.action);
    let parent_title = if change.action == ParentChangeAction::Release {
        change.previous_parent_thread_title.as_deref()
    } else {
        change.next_parent_thread_title.as_deref()
    };
    let parent = parent_title.map(js_trim).filter(|t| !t.is_empty()).unwrap_or("parent");
    let suffix = format!(" {verb} {parent}");
    if row.title.ends_with(&suffix) && row.title.len() > suffix.len() {
        return row.title[..row.title.len() - suffix.len()].to_string();
    }
    row.base.thread_id.clone()
}

fn map_parent_change_system_title(
    row: &SystemRow,
    fields: &ParentChangeOperationFields,
) -> TimelineTitle {
    let change = &fields.parent_change;
    let shimmer = row.status == Some(RowStatus::Pending);
    let released = change.action == ParentChangeAction::Release;
    let mut thread =
        segment(&parent_change_thread_name(row, fields)).em().truncate().shimmer(shimmer);
    if !row.base.thread_id.is_empty() {
        thread = thread.link(&row.base.thread_id);
    }
    let (parent_id, parent_title) = if released {
        (&change.previous_parent_thread_id, &change.previous_parent_thread_title)
    } else {
        (&change.next_parent_thread_id, &change.next_parent_thread_title)
    };
    make_title(
        vec![
            thread,
            segment(ownership_change_verb(change.action))
                .shimmer(shimmer)
                .accent(Some(TimelineTitleSegmentAccent::Muted)),
            parent_change_parent_segment(parent_id.as_deref(), parent_title.as_deref()),
        ],
        match row.status {
            Some(RowStatus::Error) => {
                vec![status_decoration(TimelineStatusDecorationStatus::Error, None, true)]
            }
            Some(RowStatus::Interrupted) => {
                vec![status_decoration(TimelineStatusDecorationStatus::Interrupted, None, false)]
            }
            _ => Vec::new(),
        },
    )
}

fn map_system_title(row: &SystemRow) -> TimelineTitle {
    let (operation_kind, completed_at) = match &row.system {
        SystemDetail::ParentChange(fields) => return map_parent_change_system_title(row, fields),
        SystemDetail::Operation(fields) => (Some(fields.operation_kind), fields.completed_at),
        SystemDetail::NonOperation(_) => (None, None),
    };
    let has_error = matches!(
        &row.system,
        SystemDetail::NonOperation(fields) if fields.system_kind == NonOperationSystemKind::Error
    ) || row.status == Some(RowStatus::Error);
    let pending = row.status == Some(RowStatus::Pending);
    let is_reasoning = operation_kind == Some(SystemOperationKind::Reasoning);
    let is_compaction = operation_kind == Some(SystemOperationKind::Compaction);
    let title_text = if is_reasoning {
        if pending { "Thinking…".to_string() } else { "Thought".to_string() }
    } else if is_compaction && pending {
        format!("{}…", row.title)
    } else {
        row.title.clone()
    };
    let decorations = if has_error {
        vec![status_decoration(TimelineStatusDecorationStatus::Error, None, true)]
    } else if is_reasoning
        || (is_compaction && (pending || row.status == Some(RowStatus::Completed)))
    {
        duration_decorations(Timed { started_at: row.base.started_at, completed_at }, false)
    } else {
        Vec::new()
    };
    make_title(vec![segment(&title_text).shimmer(pending).truncate()], decorations)
}

/// `findTimelineFrontierRow`: the last row that is not a user message.
pub fn find_timeline_frontier_row(rows: &[ViewRow]) -> Option<&ViewRow> {
    rows.iter().rev().find(|row| {
        !matches!(row, ViewRow::Conversation(c) if matches!(c.role, ConversationRole::User(_)))
    })
}

/// `findActiveLatestBundleId`: the frontier row's id when it is a bundle summary.
pub fn find_active_latest_bundle_id(rows: &[ViewRow]) -> Option<String> {
    match find_timeline_frontier_row(rows) {
        Some(ViewRow::Summary(summary)) if summary.kind == SummaryKind::BundleSummary => {
            Some(summary.base.id.clone())
        }
        _ => None,
    }
}

/// `buildTimelineRowTitle`.
pub fn build_timeline_row_title(row: &ViewRow, options: &TimelineTitleOptions) -> TimelineTitle {
    match row {
        ViewRow::Conversation(c) => {
            let who =
                if matches!(c.role, ConversationRole::User(_)) { "User" } else { "Assistant" };
            make_title(vec![segment(who)], Vec::new())
        }
        ViewRow::System(system) => map_system_title(system),
        ViewRow::Work(work) => {
            let mut title = map_work_title(&work.row);
            if options.work_style == TitleWorkStyle::Summary {
                title.tone = TimelineTitleTone::Summary;
            }
            title
        }
        ViewRow::Summary(summary) => map_work_summary_title(summary, options),
        ViewRow::Turn(turn) => map_turn_title(&turn.row),
    }
}

/// `isBackgroundCommandTaskType` (`LOCAL_BASH_TASK_TYPE` from `@bb/domain`).
fn is_background_command_task_type(task_type: &str) -> bool {
    task_type == "local_bash"
}

/// `isBackgroundAgentTaskType` (`LOCAL_AGENT_TASK_TYPE`, `LOCAL_SUBAGENT_TASK_TYPE`).
fn is_background_agent_task_type(task_type: &str) -> bool {
    task_type == "local_agent" || task_type == "local_subagent"
}
