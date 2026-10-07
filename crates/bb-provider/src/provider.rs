use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use bb_core::{
    ExecutionOptions, ProviderId, ProviderModels, ProviderStatus, RunnerResult, SessionSpec,
    ToolCallResponse,
};
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event_builder::EventBuilder;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalEnforcer {
    Runner,
    Provider,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SteerOutcome {
    Steered,
    Stale,
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> ProviderId;
    fn approval_enforced_by(&self) -> ApprovalEnforcer;
    async fn status(&self) -> RunnerResult<ProviderStatus>;
    async fn list_models(&self, cwd: Option<&str>) -> RunnerResult<ProviderModels>;
    async fn open(
        &self,
        spec: SessionSpec,
        options: ExecutionOptions,
        host: SessionHost,
    ) -> RunnerResult<Arc<dyn ProviderSession>>;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInput {
    pub client_request_id: String,
    pub input: Vec<Value>,
    pub options: ExecutionOptions,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerInput {
    pub client_request_id: String,
    pub input: Vec<Value>,
    pub options: ExecutionOptions,
    pub expected_turn_id: String,
}

/// `rename` is optional in TypeScript: sessions without it keep the default no-op and report
/// `supports_rename() == false`.
#[async_trait]
pub trait ProviderSession: Send + Sync {
    fn provider_thread_id(&self) -> String;
    fn can_apply(&self, spec: &SessionSpec, options: &ExecutionOptions) -> bool;
    async fn start_turn(&self, args: TurnInput) -> RunnerResult<()>;
    async fn steer(&self, args: SteerInput) -> RunnerResult<SteerOutcome>;
    async fn interrupt(&self) -> RunnerResult<()>;
    async fn close(&self) -> RunnerResult<()>;
    fn supports_rename(&self) -> bool {
        false
    }
    async fn rename(&self, _title: &str) -> RunnerResult<()> {
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub call_id: String,
    pub tool: String,
    pub arguments: Value,
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interaction {
    pub payload: Value,
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    pub message: String,
    pub stderr_tail: String,
}

#[async_trait]
pub trait SessionHostCallbacks: Send + Sync {
    async fn call_tool(&self, call: ToolCall) -> RunnerResult<ToolCallResponse>;
    async fn request_interaction(&self, interaction: Interaction) -> RunnerResult<Value>;
    fn on_exit(&self, info: ExitInfo);
}

#[derive(Clone)]
pub struct SessionHost {
    pub events: Arc<EventBuilder>,
    pub env: IndexMap<String, String>,
    pub process_env: IndexMap<String, String>,
    pub thread_storage_dir: String,
    pub writable_roots: Vec<String>,
    pub callbacks: Arc<dyn SessionHostCallbacks>,
}

impl SessionHost {
    pub async fn call_tool(&self, call: ToolCall) -> RunnerResult<ToolCallResponse> {
        self.callbacks.call_tool(call).await
    }

    pub async fn request_interaction(&self, interaction: Interaction) -> RunnerResult<Value> {
        self.callbacks.request_interaction(interaction).await
    }

    pub fn on_exit(&self, info: ExitInfo) {
        self.callbacks.on_exit(info)
    }
}

const TITLE_MAX_LENGTH: usize = 160;
static SHELL_WRAPPER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:\S*/)?(?:sh|bash|zsh)\s+(?:-lc|-c)\s+([\s\S]+)$").expect("valid regex")
});

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// Cuts `text` to `max_length` UTF-16 code units (JavaScript `length`) ending in `…`, without
/// splitting a surrogate pair.
pub fn ellipsize(text: &str, max_length: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max_length {
        return text.to_owned();
    }
    let splits_pair = max_length
        .checked_sub(2)
        .and_then(|at| units.get(at))
        .is_some_and(|code| (0xd800..=0xdbff).contains(code));
    let cut = max_length as isize - if splits_pair { 2 } else { 1 };
    let end = if cut < 0 { (units.len() as isize + cut).max(0) } else { cut } as usize;
    let end = end.min(units.len());
    format!("{}…", String::from_utf16_lossy(&units[..end]))
}

pub fn presentation_title(text: &str) -> Option<String> {
    let first_line = js_trim(js_trim(text).split('\n').next().unwrap_or(""));
    if first_line.is_empty() {
        return None;
    }
    Some(ellipsize(first_line, TITLE_MAX_LENGTH))
}

pub fn file_name(path: &str) -> String {
    path.split('/').rfind(|part| !part.is_empty()).unwrap_or(path).to_owned()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresentationLabel {
    pub pending: String,
    pub completed: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresentationIcon {
    pub glyph: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub label: PresentationLabel,
    pub icon: PresentationIcon,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suppress: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<Value>,
}

impl Presentation {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

pub fn presentation(
    pending: &str,
    completed: &str,
    glyph: &str,
    title: Option<&str>,
) -> Presentation {
    Presentation {
        label: PresentationLabel { pending: pending.to_owned(), completed: completed.to_owned() },
        icon: PresentationIcon { glyph: glyph.to_owned() },
        title: title.and_then(presentation_title),
        detail: None,
        suppress: None,
        tint: None,
        badge: None,
    }
}

fn unwrap_shell_command(command: &str) -> String {
    let trimmed = js_trim(command);
    let inner = SHELL_WRAPPER
        .captures(trimmed)
        .and_then(|captures| captures.get(1))
        .map(|inner| js_trim(inner.as_str()))
        .unwrap_or("");
    if inner.is_empty() {
        return trimmed.to_owned();
    }
    let mut chars = inner.chars();
    let first = chars.next();
    let last = chars.next_back();
    let quoted = matches!(first, Some('"' | '\'')) && first == last;
    if quoted {
        let start = 1;
        let end = inner.len() - 1;
        inner[start..end].to_owned()
    } else {
        inner.to_owned()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchMode {
    Content,
    Path,
}

pub mod labels {
    use super::*;

    pub fn message() -> Presentation {
        presentation("Responding", "Responded", "MessageSquare", None)
    }

    pub fn reasoning() -> Presentation {
        presentation("Thinking", "Thought", "Brain", None)
    }

    pub fn plan() -> Presentation {
        presentation("Writing plan", "Wrote plan", "ListTodo", None)
    }

    pub fn compaction() -> Presentation {
        presentation("Compacting context", "Compacted context", "Archive", None)
    }

    pub fn command(command: &str) -> Presentation {
        let title = unwrap_shell_command(command);
        presentation("Running command", "Ran command", "Terminal", Some(&title))
    }

    pub fn file_change<S: AsRef<str>>(paths: &[S]) -> Presentation {
        let names: IndexSet<String> = paths.iter().map(|path| file_name(path.as_ref())).collect();
        let noun = if names.len() > 1 { "files" } else { "file" };
        let title = names.iter().map(String::as_str).collect::<Vec<_>>().join(", ");
        let title = (!names.is_empty()).then_some(title.as_str());
        presentation(&format!("Editing {noun}"), &format!("Edited {noun}"), "EditFile", title)
    }

    pub fn file_read(path: &str) -> Presentation {
        presentation("Reading file", "Read file", "FileText", Some(&file_name(path)))
    }

    pub fn search(mode: SearchMode, query: &str) -> Presentation {
        match mode {
            SearchMode::Content => {
                presentation("Searching files", "Searched files", "Search", Some(query))
            }
            SearchMode::Path => {
                presentation("Finding files", "Found files", "FolderOpen", Some(query))
            }
        }
    }

    pub fn web_search(query: Option<&str>) -> Presentation {
        presentation("Searching the web", "Searched the web", "Globe", query)
    }

    pub fn web_fetch(url: &str) -> Presentation {
        presentation("Fetching page", "Fetched page", "Browser", Some(url))
    }

    pub fn image_view(path: &str) -> Presentation {
        presentation("Viewing image", "Viewed image", "Eye", Some(&file_name(path)))
    }

    pub fn plan_steps(headline: Option<&str>) -> Presentation {
        presentation("Updating plan", "Updated plan", "ListTodo", headline)
    }

    pub fn tool(tool: &str, title: Option<&str>) -> Presentation {
        presentation(&format!("Running {tool}"), &format!("Ran {tool}"), "Toolbox", title)
    }

    pub fn agent(title: &str) -> Presentation {
        presentation("Running agent", "Agent finished", "UserRound", Some(title))
    }
}

fn comparable_lines(text: Option<&str>) -> Vec<String> {
    let Some(text) = text else { return Vec::new() };
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<String> = normalized.split('\n').map(str::to_owned).collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

const MAX_LINE_DIFF_CELLS: usize = 1_000_000;

fn changed_lines(before: &[String], after: &[String]) -> Vec<String> {
    let mut start = 0;
    while start < before.len() && after.get(start) == Some(&before[start]) {
        start += 1;
    }
    let mut end = 0;
    let shorter = before.len().min(after.len()) - start;
    while end < shorter && before[before.len() - 1 - end] == after[after.len() - 1 - end] {
        end += 1;
    }
    let a = &before[start..before.len() - end];
    let b = &after[start..after.len() - end];
    let width = b.len() + 1;
    if (a.len() + 1) * width > MAX_LINE_DIFF_CELLS {
        let removed = a.iter().map(|line| format!("-{line}"));
        return removed.chain(b.iter().map(|line| format!("+{line}"))).collect();
    }
    let mut lcs = vec![0u32; (a.len() + 1) * width];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            let longest = lcs[(i + 1) * width + j].max(lcs[i * width + j + 1]);
            lcs[i * width + j] =
                if a[i] == b[j] { lcs[(i + 1) * width + j + 1] + 1 } else { longest };
        }
    }
    let at = |i: usize, j: usize| lcs[i * width + j];
    let mut output = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        let removes = i < a.len() && at(i + 1, j) >= at(i, j + 1);
        if i < a.len() && j < b.len() && a[i] == b[j] {
            i += 1;
            j += 1;
        } else if j >= b.len() || removes {
            output.push(format!("-{}", a[i]));
            i += 1;
        } else {
            output.push(format!("+{}", b[j]));
            j += 1;
        }
    }
    output
}

pub fn build_edit_diff(
    file_path: &str,
    old_text: Option<&str>,
    new_text: Option<&str>,
) -> Option<String> {
    if old_text.is_none() && new_text.is_none() {
        return None;
    }
    let path = file_path.replace('\\', "/");
    let path = path.trim_start_matches('/');
    let body = changed_lines(&comparable_lines(old_text), &comparable_lines(new_text));
    if old_text.is_some() && new_text.is_some() && body.is_empty() {
        return None;
    }
    let from =
        if old_text.is_none() { "--- /dev/null".to_owned() } else { format!("--- a/{path}") };
    let to = if new_text.is_none() { "+++ /dev/null".to_owned() } else { format!("+++ b/{path}") };
    let mut lines = vec![from, to];
    lines.extend(body);
    Some(format!("{}\n", lines.join("\n")))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_input_tokens: Option<u64>,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}

pub const ZERO_TOKEN_USAGE: TokenUsage = TokenUsage {
    total_tokens: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_read_input_tokens: None,
    cache_write_input_tokens: None,
    output_tokens: 0,
    reasoning_output_tokens: 0,
};

fn add_optional(total: Option<u64>, last: Option<u64>) -> Option<u64> {
    match (total, last) {
        (None, None) => None,
        (total, None) => total,
        (total, Some(last)) => Some(total.unwrap_or(0) + last),
    }
}

pub fn add_token_usage(total: &TokenUsage, last: &TokenUsage) -> TokenUsage {
    TokenUsage {
        total_tokens: total.total_tokens + last.total_tokens,
        input_tokens: total.input_tokens + last.input_tokens,
        cached_input_tokens: total.cached_input_tokens + last.cached_input_tokens,
        cache_read_input_tokens: add_optional(
            total.cache_read_input_tokens,
            last.cache_read_input_tokens,
        ),
        cache_write_input_tokens: add_optional(
            total.cache_write_input_tokens,
            last.cache_write_input_tokens,
        ),
        output_tokens: total.output_tokens + last.output_tokens,
        reasoning_output_tokens: total.reasoning_output_tokens + last.reasoning_output_tokens,
    }
}
