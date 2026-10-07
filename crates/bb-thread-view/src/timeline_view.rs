//! View rows: the port of `packages/thread-view/src/timeline-view.ts` without the identity cache.

use indexmap::IndexSet;
use serde::{Serialize, Serializer};
use serde_json::Value;

use crate::format::{
    ExplorationRow, FileChangeAction, FileChangeRef, file_read_activity_intent,
    get_file_change_action, get_timeline_activity_intent_detail_dedupe_key,
    has_timeline_exploration_intent, plural, search_activity_intent, timeline_row_activity_intents,
};
use crate::rows::{
    ActivityIntent, ApprovalStatus, ConversationRole, ConversationRow, GenericOperationFields,
    RowBase, RowStatus, SystemDetail, SystemOperationKind, SystemRow, TimelineRow,
    TurnRequestStatus, TurnRow, WorkDetail, WorkRow,
};

/// `ThreadTimelineViewRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ViewRow {
    Conversation(ConversationRow),
    Work(ViewWorkRow),
    System(SystemRow),
    Summary(WorkSummaryRow),
    Turn(ViewTurnRow),
}

impl ViewRow {
    pub fn base(&self) -> &RowBase {
        match self {
            Self::Conversation(row) => &row.base,
            Self::Work(row) => &row.row.base,
            Self::System(row) => &row.base,
            Self::Summary(row) => &row.base,
            Self::Turn(row) => &row.row.base,
        }
    }

    pub fn id(&self) -> &str {
        &self.base().id
    }

    /// The `kind` string: `conversation`, `work`, `system`, `step-summary`, `bundle-summary` or
    /// `turn`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Conversation(_) => "conversation",
            Self::Work(_) => "work",
            Self::System(_) => "system",
            Self::Summary(row) => row.kind.as_str(),
            Self::Turn(_) => "turn",
        }
    }
}

/// `TimelineViewWorkRow`. For a delegation, `row.work`'s `child_rows` is empty and the view child
/// rows are in `child_rows`, which serializes in its place; `child_rows` is empty for every other
/// work kind. `in_closed_step` serializes as `inClosedStep: true` only when set.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewWorkRow {
    pub row: WorkRow,
    pub in_closed_step: bool,
    pub child_rows: Vec<ViewRow>,
}

impl ViewWorkRow {
    pub fn work_kind(&self) -> &'static str {
        self.row.work.work_kind()
    }

    pub fn is_delegation(&self) -> bool {
        matches!(self.row.work, WorkDetail::Delegation(_))
    }
}

impl Serialize for ViewWorkRow {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut value = serde_json::to_value(&self.row).map_err(serde::ser::Error::custom)?;
        if let Value::Object(object) = &mut value {
            if self.is_delegation() {
                let child_rows =
                    serde_json::to_value(&self.child_rows).map_err(serde::ser::Error::custom)?;
                object.insert("childRows".to_string(), child_rows);
            }
            if self.in_closed_step {
                object.insert("inClosedStep".to_string(), Value::Bool(true));
            }
        }
        value.serialize(serializer)
    }
}

/// `TimelineViewTurnRow`: `row.children` is `None`; the view children are in `children`, which
/// serializes in its place.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewTurnRow {
    pub row: TurnRow,
    pub children: Option<Vec<ViewRow>>,
}

impl Serialize for ViewTurnRow {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut value = serde_json::to_value(&self.row).map_err(serde::ser::Error::custom)?;
        if let Value::Object(object) = &mut value {
            let children =
                serde_json::to_value(&self.children).map_err(serde::ser::Error::custom)?;
            object.insert("children".to_string(), children);
        }
        value.serialize(serializer)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SummaryKind {
    StepSummary,
    BundleSummary,
}

impl SummaryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StepSummary => "step-summary",
            Self::BundleSummary => "bundle-summary",
        }
    }
}

/// `TimelineWorkSummaryChild`: a work row or a completed reasoning operation row.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SummaryChild {
    Work(ViewWorkRow),
    Reasoning(SystemRow),
}

impl SummaryChild {
    pub fn base(&self) -> &RowBase {
        match self {
            Self::Work(row) => &row.row.base,
            Self::Reasoning(row) => &row.base,
        }
    }

    pub fn status(&self) -> RowStatus {
        match self {
            Self::Work(row) => row.row.status,
            Self::Reasoning(row) => row.status.unwrap_or(RowStatus::Completed),
        }
    }

    fn into_view_row(self) -> ViewRow {
        match self {
            Self::Work(row) => ViewRow::Work(row),
            Self::Reasoning(row) => ViewRow::System(row),
        }
    }
}

/// `TimelineWorkSummaryRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSummaryRow {
    #[serde(flatten)]
    pub base: RowBase,
    pub status: RowStatus,
    pub kind: SummaryKind,
    pub children: Vec<SummaryChild>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Category {
    Commands,
    Delegations,
    Exploration,
    Extensions,
    FileChanges,
    ImageGenerations,
    ImageViews,
    PlanUpdates,
    Tools,
    WebResearch,
}

fn exploration_row(work: &WorkDetail) -> Option<ExplorationRow<'_>> {
    match work {
        WorkDetail::Command(row) => Some(ExplorationRow::Command(row)),
        WorkDetail::FileRead(row) => Some(ExplorationRow::FileRead(row)),
        WorkDetail::Search(row) => Some(ExplorationRow::Search(row)),
        _ => None,
    }
}

fn summary_category(row: &ViewWorkRow) -> Option<Category> {
    Some(match &row.row.work {
        WorkDetail::Command(command) => {
            if has_timeline_exploration_intent(ExplorationRow::Command(command)) {
                Category::Exploration
            } else {
                Category::Commands
            }
        }
        WorkDetail::Tool(_) => Category::Tools,
        WorkDetail::FileRead(_) | WorkDetail::Search(_) => Category::Exploration,
        WorkDetail::PlanSteps(_) => Category::PlanUpdates,
        WorkDetail::Extension(_) => Category::Extensions,
        WorkDetail::FileChange(_) => Category::FileChanges,
        WorkDetail::WebFetch(_) | WorkDetail::WebSearch(_) => Category::WebResearch,
        WorkDetail::ImageGeneration(_) => Category::ImageGenerations,
        WorkDetail::ImageView(_) => Category::ImageViews,
        WorkDetail::Delegation(_) => Category::Delegations,
        WorkDetail::Approval(_)
        | WorkDetail::Question(_)
        | WorkDetail::Form(_)
        | WorkDetail::Workflow(_) => return None,
    })
}

fn approval_status_summary_label(rows: &[&ViewWorkRow]) -> Option<String> {
    let statuses: IndexSet<Option<ApprovalStatus>> = rows
        .iter()
        .map(|row| match &row.row.work {
            WorkDetail::Command(work) => work.approval_status,
            WorkDetail::FileChange(work) => work.approval_status,
            WorkDetail::Tool(work) => work.approval_status,
            _ => None,
        })
        .collect();
    if statuses.len() != 1 {
        return None;
    }
    let status = (*statuses.first()?)?;
    let detail = [("command", "command"), ("file-change", "file change"), ("tool", "tool")]
        .iter()
        .filter_map(|(work_kind, noun)| {
            let count = rows.iter().filter(|row| row.work_kind() == *work_kind).count();
            (count > 0).then(|| plural(count as i64, noun, None))
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(match status {
        ApprovalStatus::Denied => format!("Denied {detail}"),
        ApprovalStatus::WaitingForApproval => format!("Waiting for approval on {detail}"),
    })
}

fn intent_type(intent: &ActivityIntent) -> &'static str {
    match intent {
        ActivityIntent::Read { .. } => "read",
        ActivityIntent::ListFiles { .. } => "list_files",
        ActivityIntent::Search { .. } => "search",
        ActivityIntent::Unknown { .. } => "unknown",
    }
}

fn read_target<'a>(path: &'a Option<String>, name: &'a str) -> &'a str {
    path.as_deref().unwrap_or(name)
}

fn exploration_summary_phrase(rows: &[&ViewWorkRow], active: bool) -> Option<String> {
    let intents: Vec<ActivityIntent> = rows
        .iter()
        .filter_map(|row| exploration_row(&row.row.work))
        .flat_map(timeline_row_activity_intents)
        .collect();
    let mut files: IndexSet<&str> = intents
        .iter()
        .filter_map(|intent| match intent {
            ActivityIntent::Read { path, name, .. } => Some(read_target(path, name)),
            _ => None,
        })
        .collect();
    files.shift_remove("");
    let count = |kind: &str| intents.iter().filter(|intent| intent_type(intent) == kind).count();
    let parts: IndexSet<String> = intents
        .iter()
        .filter_map(|intent| match intent {
            ActivityIntent::Unknown { .. } => None,
            ActivityIntent::Read { path, name, .. } => (!read_target(path, name).is_empty())
                .then(|| plural(files.len() as i64, "file", None)),
            ActivityIntent::Search { .. } => {
                Some(plural(count("search") as i64, "search", Some("searches")))
            }
            ActivityIntent::ListFiles { .. } => {
                Some(plural(count("list_files") as i64, "list", None))
            }
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    let verb = if active { "Exploring" } else { "Explored" };
    Some(format!("{verb} {}", parts.into_iter().collect::<Vec<_>>().join(", ")))
}

fn file_change_summary_phrase(rows: &[&ViewWorkRow], active: bool) -> String {
    let changes: Vec<FileChangeRef<'_>> = rows
        .iter()
        .filter_map(|row| match &row.row.work {
            WorkDetail::FileChange(work) => Some(FileChangeRef::from(&work.change)),
            _ => None,
        })
        .collect();
    let actions: IndexSet<FileChangeAction> = changes.iter().map(get_file_change_action).collect();
    let total: IndexSet<(FileChangeAction, &str)> = changes
        .iter()
        .map(|change| (get_file_change_action(change), change.move_path.unwrap_or(change.path)))
        .collect();
    let action = match actions.first() {
        Some(only) if actions.len() == 1 => *only,
        _ => FileChangeAction::Edited,
    };
    let verb = if active { action.present() } else { action.past() };
    format!("{verb} {}", plural(total.len() as i64, "file", None))
}

fn web_research_summary_phrase(rows: &[&ViewWorkRow], active: bool) -> String {
    let mut queries = 0;
    let mut pages = 0;
    for row in rows {
        match &row.row.work {
            WorkDetail::WebSearch(work) => queries += work.queries.len().max(1),
            WorkDetail::WebFetch(_) => pages += 1,
            _ => {}
        }
    }
    let mut parts = Vec::new();
    if queries > 0 {
        parts.push(plural(queries as i64, "search query", Some("search queries")));
    }
    if pages > 0 {
        parts.push(plural(pages, "web page", None));
    }
    let verb = if active { "Researching" } else { "Researched" };
    format!("{verb} {}", parts.join(", "))
}

fn summary_phrase(category: Category, rows: &[&ViewWorkRow], active: bool) -> Option<String> {
    let count = rows.len() as i64;
    let pick = |present: &str, past: &str| if active { present } else { past }.to_string();
    Some(match category {
        Category::Exploration => return exploration_summary_phrase(rows, active),
        Category::FileChanges => file_change_summary_phrase(rows, active),
        Category::WebResearch => web_research_summary_phrase(rows, active),
        Category::ImageGenerations => {
            format!("{} {}", pick("Generating", "Generated"), plural(count, "image", None))
        }
        Category::ImageViews => {
            format!("{} {}", pick("Viewing", "Viewed"), plural(count, "image", None))
        }
        Category::PlanUpdates if active => "Updating plan".to_string(),
        Category::PlanUpdates => format!("Updated plan {}", plural(count, "time", None)),
        Category::Commands | Category::Delegations | Category::Tools | Category::Extensions => {
            let noun = match category {
                Category::Commands => "command",
                Category::Delegations => "subagent",
                Category::Tools => "tool",
                _ => "plugin step",
            };
            format!("{} {}", pick("Running", "Ran"), plural(count, noun, None))
        }
    })
}

fn lowercase_first(phrase: &str) -> String {
    let mut chars = phrase.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `buildTimelineWorkSummaryLabel`.
pub fn build_timeline_work_summary_label(row: &WorkSummaryRow, active: bool) -> String {
    let work: Vec<&ViewWorkRow> = row
        .children
        .iter()
        .filter_map(|child| match child {
            SummaryChild::Work(work) => Some(work),
            SummaryChild::Reasoning(_) => None,
        })
        .collect();
    if let Some(label) = approval_status_summary_label(&work) {
        return label;
    }
    let mut rows_by_category: Vec<(Category, Vec<&ViewWorkRow>)> = Vec::new();
    for child in &work {
        let Some(category) = summary_category(child) else {
            continue;
        };
        match rows_by_category.iter_mut().find(|(existing, _)| *existing == category) {
            Some((_, rows)) => rows.push(child),
            None => rows_by_category.push((category, vec![child])),
        }
    }
    let phrases: Vec<String> = rows_by_category
        .iter()
        .filter_map(|(category, rows)| summary_phrase(*category, rows, active))
        .collect();
    if phrases.is_empty() {
        return if active { "Working" } else { "Worked" }.to_string();
    }
    phrases
        .iter()
        .enumerate()
        .map(|(index, phrase)| if index == 0 { phrase.clone() } else { lowercase_first(phrase) })
        .collect::<Vec<_>>()
        .join(", ")
}

fn merge_timeline_status(left: RowStatus, right: RowStatus) -> RowStatus {
    use RowStatus::{Completed, Error, Interrupted, Pending};
    if left == Error || right == Error {
        Error
    } else if left == Pending || right == Pending {
        Pending
    } else if left == Interrupted || right == Interrupted {
        Interrupted
    } else {
        Completed
    }
}

fn summarize_range(first: &SummaryChild, children: &[SummaryChild]) -> (RowBase, RowStatus) {
    let first_base = first.base();
    let mut range = first_base.clone();
    let mut status = first.status();
    for child in children {
        let base = child.base();
        range.source_seq_start = range.source_seq_start.min(base.source_seq_start);
        range.source_seq_end = range.source_seq_end.max(base.source_seq_end);
        range.started_at = range.started_at.min(base.started_at);
        range.created_at = range.created_at.max(base.created_at);
        status = merge_timeline_status(status, child.status());
        if range.turn_id != base.turn_id {
            range.turn_id = None;
        }
    }
    range.id = [
        first_base.thread_id.as_str(),
        range.turn_id.as_deref().unwrap_or("thread"),
        "work-summary",
        first_base.id.as_str(),
    ]
    .join(":");
    (range, status)
}

fn is_reasoning_summary_child(row: &SystemRow) -> bool {
    matches!(
        &row.system,
        SystemDetail::Operation(GenericOperationFields {
            operation_kind: SystemOperationKind::Reasoning,
            ..
        })
    ) && row.status == Some(RowStatus::Completed)
}

fn is_summarizable_activity_row(row: &ViewRow) -> bool {
    match row {
        ViewRow::System(system) => is_reasoning_summary_child(system),
        ViewRow::Work(work) => !matches!(
            work.row.work,
            WorkDetail::Approval(_) | WorkDetail::Question(_) | WorkDetail::Workflow(_)
        ),
        _ => false,
    }
}

fn is_timeline_step_boundary(row: &ViewRow) -> bool {
    match row {
        ViewRow::Conversation(conversation) => !matches!(
            &conversation.role,
            ConversationRole::User(user) if user.turn_request.status == TurnRequestStatus::Pending
        ),
        _ => false,
    }
}

fn item_dedupe_key(work: &WorkDetail) -> Option<String> {
    let intent = match work {
        WorkDetail::FileRead(row) => file_read_activity_intent(row),
        WorkDetail::Search(row) => search_activity_intent(row),
        _ => return None,
    };
    get_timeline_activity_intent_detail_dedupe_key(&intent)
}

fn dedupe_bundle_child_intents(children: Vec<SummaryChild>) -> Vec<SummaryChild> {
    let mut last_emitted_key: Option<String> = None;
    let mut out = Vec::with_capacity(children.len());
    for child in children {
        let SummaryChild::Work(work) = &child else {
            last_emitted_key = None;
            out.push(child);
            continue;
        };
        match &work.row.work {
            WorkDetail::FileRead(_) | WorkDetail::Search(_) => {
                let key = item_dedupe_key(&work.row.work);
                if key.is_some() && key == last_emitted_key {
                    continue;
                }
                last_emitted_key = key;
                out.push(child);
            }
            WorkDetail::Command(command) if !command.activity_intents.is_empty() => {
                let was_exploration =
                    has_timeline_exploration_intent(ExplorationRow::Command(command));
                let mut filtered = Vec::new();
                for intent in &command.activity_intents {
                    let key = get_timeline_activity_intent_detail_dedupe_key(intent);
                    if key.is_some() && key == last_emitted_key {
                        continue;
                    }
                    filtered.push(intent.clone());
                    if !intent.is_unknown() {
                        last_emitted_key = key;
                    }
                }
                if filtered.len() == command.activity_intents.len() {
                    out.push(child);
                } else if !was_exploration || filtered.iter().any(|intent| !intent.is_unknown()) {
                    let mut work = work.clone();
                    if let WorkDetail::Command(command) = &mut work.row.work {
                        command.activity_intents = filtered;
                    }
                    out.push(SummaryChild::Work(work));
                }
            }
            _ => {
                last_emitted_key = None;
                out.push(child);
            }
        }
    }
    out
}

fn build_summary_row(kind: SummaryKind, children: Vec<SummaryChild>) -> Vec<ViewRow> {
    let children = dedupe_bundle_child_intents(children);
    let Some(first) = children.first() else {
        return Vec::new();
    };
    let (base, status) = summarize_range(first, &children);
    vec![ViewRow::Summary(WorkSummaryRow { base, status, kind, children })]
}

fn close_open_step_at_boundary(work: Vec<SummaryChild>) -> Vec<ViewRow> {
    if work.len() > 1 && work.iter().any(|row| matches!(row, SummaryChild::Work(_))) {
        return build_summary_row(SummaryKind::StepSummary, work);
    }
    work.into_iter()
        .map(|row| match row {
            SummaryChild::Work(mut work) => {
                work.in_closed_step = true;
                ViewRow::Work(work)
            }
            SummaryChild::Reasoning(system) => ViewRow::System(system),
        })
        .collect()
}

fn flush_open_step_as_bundles(work: Vec<SummaryChild>) -> Vec<ViewRow> {
    let mut groups: Vec<(Category, Vec<SummaryChild>)> = Vec::new();
    let mut leading_thoughts: Vec<SummaryChild> = Vec::new();
    for row in work {
        let concept = match &row {
            SummaryChild::Reasoning(_) => {
                match groups.last_mut() {
                    Some((_, rows)) => rows.push(row),
                    None => leading_thoughts.push(row),
                }
                continue;
            }
            SummaryChild::Work(work) => summary_category(work).unwrap_or(Category::Tools),
        };
        match groups.last_mut() {
            Some((last, rows)) if *last == concept => rows.push(row),
            _ => {
                let mut rows = std::mem::take(&mut leading_thoughts);
                rows.push(row);
                groups.push((concept, rows));
            }
        }
    }
    let mut out: Vec<ViewRow> =
        leading_thoughts.into_iter().map(SummaryChild::into_view_row).collect();
    for (_, mut rows) in groups {
        if rows.len() == 1 {
            out.extend(rows.pop().map(SummaryChild::into_view_row));
        } else {
            out.extend(build_summary_row(SummaryKind::BundleSummary, rows));
        }
    }
    out
}

fn to_timeline_view_row(row: &TimelineRow) -> ViewRow {
    match row {
        TimelineRow::Conversation(row) => ViewRow::Conversation(row.clone()),
        TimelineRow::System(row) => ViewRow::System(row.clone()),
        TimelineRow::Turn(turn) => {
            let children = turn.children.as_deref().map(|rows| build_view_rows(rows, true));
            ViewRow::Turn(ViewTurnRow { row: TurnRow { children: None, ..turn.clone() }, children })
        }
        TimelineRow::Work(work) => {
            let mut row = work.clone();
            let child_rows = match &mut row.work {
                WorkDetail::Delegation(delegation) => {
                    let child_rows = std::mem::take(&mut delegation.child_rows);
                    build_view_rows(&child_rows, work.status != RowStatus::Pending)
                }
                _ => Vec::new(),
            };
            ViewRow::Work(ViewWorkRow { row, in_closed_step: false, child_rows })
        }
    }
}

fn build_view_rows(rows: &[TimelineRow], closed_scope: bool) -> Vec<ViewRow> {
    let mut result = Vec::with_capacity(rows.len());
    let mut open_step: Vec<SummaryChild> = Vec::new();
    for source in rows {
        let row = to_timeline_view_row(source);
        if is_summarizable_activity_row(&row) {
            match row {
                ViewRow::Work(work) => open_step.push(SummaryChild::Work(work)),
                ViewRow::System(system) => open_step.push(SummaryChild::Reasoning(system)),
                _ => {}
            }
            continue;
        }
        let step = std::mem::take(&mut open_step);
        if is_timeline_step_boundary(&row) {
            result.extend(close_open_step_at_boundary(step));
        } else {
            result.extend(flush_open_step_as_bundles(step));
        }
        result.push(row);
    }
    if closed_scope {
        result.extend(close_open_step_at_boundary(open_step));
    } else {
        result.extend(flush_open_step_as_bundles(open_step));
    }
    result
}

/// `buildTimelineViewRows`: groups consecutive activity rows into step and bundle summaries.
pub fn build_timeline_view_rows(rows: &[TimelineRow]) -> Vec<ViewRow> {
    build_view_rows(rows, false)
}
