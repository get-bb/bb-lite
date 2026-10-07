//! The text formats of `bb thread log`: the port of `apps/cli/src/log-text.ts`.

use bb_thread_view::rows::{
    ApprovalStatus, ConversationRole, RowStatus, TimelineRow, TurnRequestKind, TurnRequestStatus,
    WorkDetail,
};
use bb_thread_view::timeline_row_title::{
    TimelineTitleOptions, TitleSummaryStyle, TitleWorkStyle, build_timeline_row_title,
    find_active_latest_bundle_id,
};
use bb_thread_view::timeline_view::{SummaryChild, SummaryKind, ViewRow, build_timeline_view_rows};
use serde_json::Value;

const HEADER_WIDTH: usize = 60;

#[derive(Clone, Copy)]
struct LogContext<'a> {
    verbose: bool,
    color: bool,
    depth: usize,
    active_bundle_id: Option<&'a str>,
}

fn is_js_whitespace(c: char) -> bool {
    c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace())
}

fn indent(text: &str) -> String {
    let lines: Vec<String> = text
        .split('\n')
        .map(|l| if l.is_empty() { String::new() } else { format!("  {l}") })
        .collect();
    lines.join("\n")
}

fn approval(status: ApprovalStatus) -> &'static str {
    match status {
        ApprovalStatus::WaitingForApproval => "waiting_for_approval",
        ApprovalStatus::Denied => "denied",
    }
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

fn summary_rows(children: &[SummaryChild]) -> Vec<ViewRow> {
    let row = |child: &SummaryChild| match child {
        SummaryChild::Work(work) => ViewRow::Work(work.clone()),
        SummaryChild::Reasoning(reasoning) => ViewRow::System(reasoning.clone()),
    };
    children.iter().map(row).collect()
}

fn format_row(row: &ViewRow, context: LogContext) -> String {
    let dim = |text: &str| -> String {
        if context.color { format!("\x1b[2m{text}\x1b[22m") } else { text.to_string() }
    };
    let options = TimelineTitleOptions {
        summary_style: TitleSummaryStyle::Bundle,
        work_style: TitleWorkStyle::Default,
        is_active_latest_bundle: context.active_bundle_id == Some(row.id()),
    };
    let plain = build_timeline_row_title(row, &options).plain;
    let width = plain.encode_utf16().count();
    let rule = "─".repeat(HEADER_WIDTH.saturating_sub(width + 4));
    let header = if context.depth == 0 && !rule.is_empty() {
        dim(&format!("── {plain} {rule}"))
    } else {
        dim(&format!("── {plain}"))
    };
    let nested = |rows: &[ViewRow]| -> String {
        let active = find_active_latest_bundle_id(rows);
        let inner =
            LogContext { depth: context.depth + 1, active_bundle_id: active.as_deref(), ..context };
        indent(&format_rows(rows, inner))
    };
    let mut lines = vec![header];
    match row {
        ViewRow::Conversation(row) => {
            lines.push(row.text.clone());
            if let ConversationRole::User(user) = &row.role
                && user.turn_request.kind == TurnRequestKind::Steer
            {
                let suffix = match user.turn_request.status {
                    TurnRequestStatus::Pending => " pending",
                    TurnRequestStatus::Rejected => " failed",
                    TurnRequestStatus::Accepted => "",
                };
                lines.push(format!("steer{suffix}"));
            }
        }
        ViewRow::System(row) => {
            if let Some(detail) = row.detail.as_deref().filter(|d| !d.is_empty()) {
                lines.push(dim(&indent(detail)));
            }
        }
        ViewRow::Turn(row) => {
            if let Some(children) = row.children.as_deref().filter(|c| !c.is_empty()) {
                lines.push(nested(children));
            }
        }
        ViewRow::Work(view) => match &view.row.work {
            WorkDetail::Command(work) => {
                let output = work.output.trim_matches(is_js_whitespace);
                lines.push(format!("  $ {}", work.command));
                if context.verbose && !output.is_empty() {
                    lines.push(dim(&indent(output)));
                }
                if let Some(code) = work.exit_code
                    && view.row.status != RowStatus::Pending
                    && (code != 0 || output.is_empty())
                {
                    lines.push(dim(&format!("  exit {code}")));
                }
            }
            WorkDetail::Tool(work) => {
                let output = work.output.trim_matches(is_js_whitespace);
                if let Some(status) = work.approval_status {
                    lines.push(format!("  {}", approval(status)));
                }
                if context.verbose && !output.is_empty() {
                    lines.push(dim(&indent(output)));
                }
            }
            WorkDetail::FileChange(work) => {
                if let Some(status) = work.approval_status {
                    lines.push(format!("  {}", approval(status)));
                }
                let diff = work.change.diff.as_deref().filter(|d| !d.is_empty());
                if let Some(diff) = diff.filter(|_| context.verbose) {
                    lines.push(dim(&indent(diff.trim_end_matches(is_js_whitespace))));
                }
            }
            WorkDetail::PlanSteps(work) if context.verbose => {
                for step in &work.steps {
                    let mark = match step.get("status").and_then(Value::as_str) {
                        Some("completed") => "[x]",
                        Some("active") => "[>]",
                        Some("failed") => "[!]",
                        _ => "[ ]",
                    };
                    lines.push(dim(&format!("  {mark} {}", js_string(step.get("step")))));
                }
            }
            WorkDetail::Delegation(_) if !view.child_rows.is_empty() => {
                lines.push(nested(&view.child_rows));
            }
            _ => {}
        },
        ViewRow::Summary(row) => {
            if (context.verbose || row.kind == SummaryKind::BundleSummary)
                && !row.children.is_empty()
            {
                lines.push(nested(&summary_rows(&row.children)));
            }
        }
    }
    lines.join("\n")
}

fn format_rows(rows: &[ViewRow], context: LogContext) -> String {
    let parts: Vec<String> = rows.iter().map(|row| format_row(row, context)).collect();
    parts.join("\n\n")
}

/// `formatTimelineText`: the timeline rows as the `minimal` (or `verbose`) text of `bb thread log`,
/// dimmed with ANSI codes when `color` is set.
pub fn format_timeline_text(rows: &[TimelineRow], verbose: bool, color: bool) -> String {
    let view_rows = build_timeline_view_rows(rows);
    let active = find_active_latest_bundle_id(&view_rows);
    let context = LogContext { verbose, color, depth: 0, active_bundle_id: active.as_deref() };
    format_rows(&view_rows, context)
}
