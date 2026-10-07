//! Formatting helpers: the port of `timeline-format.ts`, with JavaScript string semantics.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::rows::{
    ActivityIntent, CommandWork, DiffStats, FileChange, FileReadWork, ParentChangeAction,
    SearchMode, SearchWork,
};
use crate::types::FileEditChange;

/// `OWNERSHIP_CHANGE_VERBS`.
pub fn ownership_change_verb(action: ParentChangeAction) -> &'static str {
    match action {
        ParentChangeAction::Assign => "assigned to",
        ParentChangeAction::Release => "released from",
        ParentChangeAction::Transfer => "transferred to",
    }
}

/// `getMessageStartedAt`: `startedAt ?? createdAt`.
pub fn get_message_started_at(created_at: i64, started_at: Option<i64>) -> i64 {
    started_at.unwrap_or(created_at)
}

/// `getFirstStringField`: the first of `keys` holding a non-empty string.
pub fn get_first_string_field<'a>(
    record: Option<&'a Map<String, Value>>,
    keys: &[&str],
) -> Option<&'a str> {
    let record = record?;
    keys.iter()
        .find_map(|key| record.get(*key).and_then(Value::as_str).filter(|value| !value.is_empty()))
}

/// JavaScript `String.prototype.trim` whitespace (Unicode `White_Space` without U+0085, plus BOM).
pub fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// JavaScript `trimEnd`.
pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

/// JavaScript `trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `capitalize`: upper-cases the first UTF-16 unit (an astral first character is unchanged).
pub fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) if first.len_utf16() == 2 => s.to_string(),
        Some(first) => {
            let mut result: String = first.to_uppercase().collect();
            result.push_str(chars.as_str());
            result
        }
    }
}

/// `plural`: `"1 file"`, `"2 files"`, or `"2 <plural_name>"`.
pub fn plural(count: i64, singular: &str, plural_name: Option<&str>) -> String {
    if count == 1 {
        return format!("{count} {singular}");
    }
    match plural_name {
        Some(name) => format!("{count} {name}"),
        None => format!("{count} {singular}s"),
    }
}

fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `durationToCompactString`: `"350ms"`, `"42s"`, `"1h 2m 3s"`.
pub fn duration_to_compact_string(duration_ms: f64) -> String {
    if !duration_ms.is_finite() || duration_ms < 0.0 {
        return "0s".to_string();
    }
    if duration_ms < 1_000.0 {
        return format!("{}ms", js_round(duration_ms) as i64);
    }
    let total_seconds = js_round(duration_ms / 1_000.0) as i64;
    if total_seconds < 60 {
        return format!("{total_seconds}s");
    }
    let hours = total_seconds / 3_600;
    let minutes = (total_seconds % 3_600) / 60;
    let seconds = total_seconds % 60;
    let mut parts = Vec::new();
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if seconds > 0 {
        parts.push(format!("{seconds}s"));
    }
    parts.join(" ")
}

/// `durationToCompactString` for an optional duration.
pub fn duration_to_compact_string_opt(duration_ms: Option<f64>) -> Option<String> {
    duration_ms.map(duration_to_compact_string)
}

/// `messageId`: `"<threadId>:<kind>:<key>"`.
pub fn message_id(thread_id: &str, kind: &str, key: &str) -> String {
    format!("{thread_id}:{kind}:{key}")
}

/// `formatDiffCount`: `Intl.NumberFormat("en-US")` for integers (`1,234,567`).
pub fn format_diff_count(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if value < 0 {
        grouped.push('-');
    }
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// `formatDiffStatsText`: `"+3 -1"`; with `hide_zero`, zero counts are left out.
pub fn format_diff_stats_text(added: i64, removed: i64, hide_zero: bool) -> String {
    let added_text = format!("+{}", format_diff_count(added));
    let removed_text = format!("-{}", format_diff_count(removed));
    if !hide_zero {
        return format!("{added_text} {removed_text}");
    }
    let mut parts = Vec::new();
    if added > 0 {
        parts.push(added_text);
    }
    if removed > 0 {
        parts.push(removed_text);
    }
    parts.join(" ")
}

/// `TimelinePathDisplayMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PathDisplayMode {
    Compact,
    Full,
}

/// `fileNameFromPath`: the last `/` or `\` segment, or the whole path when that is empty.
pub fn file_name_from_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    match normalized.rsplit('/').next() {
        Some(candidate) if !candidate.is_empty() => candidate.to_string(),
        _ => path.to_string(),
    }
}

/// `directoryFromPath`: everything before the last `/`, or `""`.
pub fn directory_from_path(path: &str) -> &str {
    path.rfind('/').map_or("", |index| &path[..index])
}

fn format_timeline_path(path: &str, mode: PathDisplayMode) -> String {
    match mode {
        PathDisplayMode::Compact => file_name_from_path(path),
        PathDisplayMode::Full => path.to_string(),
    }
}

/// `FileChangeAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileChangeAction {
    Created,
    Deleted,
    Renamed,
    Edited,
}

impl FileChangeAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
            Self::Edited => "edited",
        }
    }

    /// `FILE_CHANGE_VERBS[action].past`.
    pub fn past(self) -> &'static str {
        match self {
            Self::Created => "Created",
            Self::Deleted => "Deleted",
            Self::Renamed => "Renamed",
            Self::Edited => "Edited",
        }
    }

    /// `FILE_CHANGE_VERBS[action].present`.
    pub fn present(self) -> &'static str {
        match self {
            Self::Created => "Creating",
            Self::Deleted => "Deleting",
            Self::Renamed => "Renaming",
            Self::Edited => "Editing",
        }
    }

    /// `FILE_CHANGE_VERBS[action].infinitive`.
    pub fn infinitive(self) -> &'static str {
        match self {
            Self::Created => "create",
            Self::Deleted => "delete",
            Self::Renamed => "rename",
            Self::Edited => "edit",
        }
    }
}

/// `FileChangeLike`: a borrowed view of a file change.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FileChangeRef<'a> {
    pub path: &'a str,
    pub kind: Option<&'a str>,
    pub move_path: Option<&'a str>,
    pub diff: Option<&'a str>,
}

impl<'a> From<&'a FileEditChange> for FileChangeRef<'a> {
    fn from(change: &'a FileEditChange) -> Self {
        Self {
            path: &change.path,
            kind: change.kind.as_deref(),
            move_path: change.move_path.as_deref(),
            diff: change.diff.as_deref(),
        }
    }
}

impl<'a> From<&'a FileChange> for FileChangeRef<'a> {
    fn from(change: &'a FileChange) -> Self {
        Self {
            path: &change.path,
            kind: change.kind.as_deref(),
            move_path: change.move_path.as_deref(),
            diff: change.diff.as_deref(),
        }
    }
}

fn normalize_file_change_kind(kind: Option<&str>) -> String {
    kind.unwrap_or("")
        .to_lowercase()
        .chars()
        .filter(|c| matches!(c, 'a'..='z' | '0'..='9'))
        .collect()
}

const PATCH_METADATA_PREFIXES: [&str; 10] = [
    "diff --git ",
    "index ",
    "new file mode ",
    "deleted file mode ",
    "similarity index ",
    "rename from ",
    "rename to ",
    "--- ",
    "+++ ",
    "@@",
];

/// `isPatchMetadataLine`.
pub fn is_patch_metadata_line(line: &str) -> bool {
    let normalized = js_trim_end(line);
    PATCH_METADATA_PREFIXES.iter().any(|prefix| normalized.starts_with(prefix))
        || normalized == "\\ No newline at end of file"
}

fn has_substantive_diff(change: &FileChangeRef<'_>) -> bool {
    let Some(diff) = change.diff.filter(|diff| !diff.is_empty()) else {
        return false;
    };
    diff.split('\n')
        .filter(|line| !line.starts_with("+++ ") && !line.starts_with("--- "))
        .any(|line| line.starts_with('+') || line.starts_with('-'))
}

/// `getFileChangeAction`.
pub fn get_file_change_action(change: &FileChangeRef<'_>) -> FileChangeAction {
    if change.move_path.is_some_and(|path| !path.is_empty()) {
        return if has_substantive_diff(change) {
            FileChangeAction::Edited
        } else {
            FileChangeAction::Renamed
        };
    }
    let kind = normalize_file_change_kind(change.kind);
    if kind.contains("add") || kind.contains("create") {
        FileChangeAction::Created
    } else if kind.contains("delete") || kind.contains("remove") {
        FileChangeAction::Deleted
    } else {
        FileChangeAction::Edited
    }
}

/// `formatFileChangePath`.
pub fn format_file_change_path(change: &FileChangeRef<'_>, mode: PathDisplayMode) -> String {
    let source_path = format_timeline_path(change.path, mode);
    let Some(move_path) = change.move_path.filter(|path| !path.is_empty()) else {
        return source_path;
    };
    let move_path = format_timeline_path(move_path, mode);
    if get_file_change_action(change) == FileChangeAction::Edited {
        move_path
    } else {
        format!("{source_path} -> {move_path}")
    }
}

fn count_plain_content_lines(diff: &str) -> u64 {
    diff.split('\n')
        .map(js_trim_end)
        .filter(|line| !js_trim(line).is_empty() && !is_patch_metadata_line(line))
        .count() as u64
}

/// `getFileChangeDiffStats`.
pub fn get_file_change_diff_stats(change: &FileChangeRef<'_>) -> DiffStats {
    let Some(diff) = change.diff.filter(|diff| !diff.is_empty()) else {
        return DiffStats::default();
    };
    let plain = count_plain_content_lines(diff);
    let whole_file = match get_file_change_action(change) {
        FileChangeAction::Created => Some(DiffStats { added: plain, removed: 0 }),
        FileChangeAction::Deleted => Some(DiffStats { added: 0, removed: plain }),
        _ => None,
    };
    if let Some(whole_file) = whole_file
        && !diff.split('\n').any(is_patch_metadata_line)
    {
        return whole_file;
    }
    let mut added = 0;
    let mut removed = 0;
    for line in diff.split('\n') {
        if line.starts_with("+++ ") || line.starts_with("--- ") {
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    if added + removed > 0 {
        return DiffStats { added, removed };
    }
    whole_file.unwrap_or_default()
}

const JS_WHITESPACE_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

static AGENT_MESSAGE_ENVELOPE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    let ws = JS_WHITESPACE_CLASS;
    Regex::new(&format!(r"^\[bb message from thread:([^;\]{ws}]+)(?:;[^\]]*)?\][{ws}]*"))
        .expect("agent message envelope pattern is valid")
});

/// `AgentMessageEnvelope`. `body_start` is a byte offset into the text (the TypeScript value is
/// a UTF-16 offset; both point at the same character).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMessageEnvelope {
    pub body_start: usize,
    pub sender_thread_id: String,
}

/// `parseAgentMessageEnvelope`: reads a `[bb message from thread:<id>;...]` prefix.
pub fn parse_agent_message_envelope(text: &str) -> Option<AgentMessageEnvelope> {
    let captures = AGENT_MESSAGE_ENVELOPE_PATTERN.captures(text)?;
    let whole = captures.get(0)?;
    let sender = captures.get(1)?.as_str();
    if sender.is_empty() {
        return None;
    }
    Some(AgentMessageEnvelope { body_start: whole.end(), sender_thread_id: sender.to_string() })
}

/// `TimelineExplorationWorkRow`: the work rows that can describe exploration.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExplorationRow<'a> {
    Command(&'a CommandWork),
    FileRead(&'a FileReadWork),
    Search(&'a SearchWork),
}

/// `itemActivityIntent` for a file-read row.
pub fn file_read_activity_intent(row: &FileReadWork) -> ActivityIntent {
    ActivityIntent::Read {
        command: row.cmd.clone().unwrap_or_else(|| row.path.clone()),
        name: "fileRead".to_string(),
        path: Some(row.path.clone()),
    }
}

/// `itemActivityIntent` for a search row.
pub fn search_activity_intent(row: &SearchWork) -> ActivityIntent {
    let command = row.cmd.clone().unwrap_or_else(|| row.query.clone());
    if row.mode == SearchMode::Content {
        return ActivityIntent::Search {
            command,
            query: Some(row.query.clone()),
            path: row.path.clone(),
        };
    }
    let path = row.path.clone().or_else(|| (!row.query.is_empty()).then(|| row.query.clone()));
    ActivityIntent::ListFiles { command, path }
}

/// `timelineRowActivityIntents`.
pub fn timeline_row_activity_intents(row: ExplorationRow<'_>) -> Vec<ActivityIntent> {
    match row {
        ExplorationRow::Command(command) => command.activity_intents.clone(),
        ExplorationRow::FileRead(read) => vec![file_read_activity_intent(read)],
        ExplorationRow::Search(search) => vec![search_activity_intent(search)],
    }
}

/// `primaryTimelineActivityIntent`: the first intent that is not `unknown`.
pub fn primary_timeline_activity_intent(row: ExplorationRow<'_>) -> Option<ActivityIntent> {
    timeline_row_activity_intents(row).into_iter().find(|intent| !intent.is_unknown())
}

/// `hasTimelineExplorationIntent`.
pub fn has_timeline_exploration_intent(row: ExplorationRow<'_>) -> bool {
    primary_timeline_activity_intent(row).is_some()
}

const SKILL_FILE_NAME: &str = "SKILL.md";

fn format_compact_skill_target(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let segments: Vec<&str> = normalized.split('/').collect();
    let file_index = segments.len() - 1;
    if segments[file_index] != SKILL_FILE_NAME {
        return None;
    }
    let at = |offset: usize| file_index.checked_sub(offset).map(|index| segments[index]);
    if let Some(plugin_name) = at(2).filter(|name| !name.is_empty())
        && at(4) == Some("cache")
        && at(5) == Some("plugins")
    {
        return Some(format!("{plugin_name}/{SKILL_FILE_NAME}"));
    }
    segments[..file_index]
        .iter()
        .rev()
        .find(|name| !name.is_empty())
        .map(|name| format!("{name}/{SKILL_FILE_NAME}"))
}

fn format_read_target(path: Option<&str>, name: &str, mode: PathDisplayMode) -> String {
    let target = path.unwrap_or(name);
    let skill_target = match mode {
        PathDisplayMode::Compact => format_compact_skill_target(target),
        PathDisplayMode::Full => None,
    };
    skill_target.unwrap_or_else(|| format_timeline_path(target, mode))
}

/// The result of [`format_timeline_activity_intent_detail_parts`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentDetailParts {
    pub prefix: Option<&'static str>,
    pub content: String,
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.is_empty())
}

/// `formatTimelineActivityIntentDetailParts`.
pub fn format_timeline_activity_intent_detail_parts(
    intent: &ActivityIntent,
    path_mode: PathDisplayMode,
    pending: bool,
) -> IntentDetailParts {
    match intent {
        ActivityIntent::Read { name, path, .. } => IntentDetailParts {
            prefix: Some(if pending { "Reading" } else { "Read" }),
            content: format_read_target(path.as_deref(), name, path_mode),
        },
        ActivityIntent::ListFiles { path, .. } => IntentDetailParts {
            prefix: Some(if pending { "Listing" } else { "Listed" }),
            content: match non_empty(path) {
                Some(path) => format!("files in {path}"),
                None => "files".to_string(),
            },
        },
        ActivityIntent::Search { query, path, .. } => IntentDetailParts {
            prefix: Some(if pending { "Searching" } else { "Searched" }),
            content: match (non_empty(query), non_empty(path)) {
                (Some(query), Some(path)) => format!("for {query} in {path}"),
                (Some(query), None) => format!("for {query}"),
                (None, Some(path)) => format!("in {path}"),
                (None, None) => "files".to_string(),
            },
        },
        ActivityIntent::Unknown { command } => {
            IntentDetailParts { prefix: None, content: command.clone() }
        }
    }
}

/// `getTimelineActivityIntentDetailDedupeKey`.
pub fn get_timeline_activity_intent_detail_dedupe_key(intent: &ActivityIntent) -> Option<String> {
    match intent {
        ActivityIntent::Read { name, path, .. } => {
            Some(format!("read:{}", path.as_deref().unwrap_or(name)))
        }
        ActivityIntent::ListFiles { path, .. } => {
            Some(format!("list:{}", path.as_deref().unwrap_or("")))
        }
        ActivityIntent::Search { query, path, .. } => Some(format!(
            "search:{}|{}",
            query.as_deref().unwrap_or(""),
            path.as_deref().unwrap_or("")
        )),
        ActivityIntent::Unknown { .. } => None,
    }
}
