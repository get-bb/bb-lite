use std::collections::HashMap;
use std::sync::Arc;

use bb_provider::{
    CloseOptions, DeltaChannel, ErrorOptions, EventBuilder, ItemKey, ItemOptions, Presentation,
    ProgressOptions, TextChannel, labels, presentation,
};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};

type Obj = Map<String, Value>;
type Parsed<T> = Result<T, Invalid>;

struct Invalid;

const GOAL_KIND: &str = "provider-codex/goal";
const BB_THREAD_NAME_PREFIX: &str = "[bb] ";
const ITEM_STATUSES: [&str; 4] = ["inProgress", "completed", "failed", "declined"];
const TURN_STATUSES: [&str; 4] = ["completed", "failed", "interrupted", "inProgress"];
const STEP_STATUSES: [&str; 4] = ["pending", "inProgress", "completed", "failed"];
const GOAL_STATUSES: [&str; 4] = ["active", "paused", "budgetLimited", "complete"];
const ACTIVITY_KINDS: [&str; 4] = ["started", "interacted", "interrupted", "completed"];
const USAGE_FIELDS: [&str; 6] = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
];

fn object(value: &Value) -> Parsed<&Obj> {
    value.as_object().ok_or(Invalid)
}

fn field<'a>(o: &'a Obj, key: &str) -> Parsed<&'a Obj> {
    o.get(key).map_or(Err(Invalid), object)
}

fn text<'a>(o: &'a Obj, key: &str) -> Parsed<&'a str> {
    o.get(key).and_then(Value::as_str).ok_or(Invalid)
}

fn optional_text<'a>(o: &'a Obj, key: &str) -> Parsed<Option<&'a str>> {
    match o.get(key) {
        None => Ok(None),
        Some(value) => value.as_str().map(Some).ok_or(Invalid),
    }
}

fn nullish_text<'a>(o: &'a Obj, key: &str) -> Parsed<Option<&'a str>> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_str().map(Some).ok_or(Invalid),
    }
}

fn nullable_text<'a>(o: &'a Obj, key: &str) -> Parsed<Option<&'a str>> {
    o.get(key).ok_or(Invalid)?;
    nullish_text(o, key)
}

fn texts(value: &Value) -> Parsed<Vec<&str>> {
    let items = value.as_array().ok_or(Invalid)?;
    items.iter().map(|item| item.as_str().ok_or(Invalid)).collect()
}

fn count<'a>(o: &'a Obj, key: &str) -> Parsed<&'a Value> {
    o.get(key).filter(|value| value.is_number()).ok_or(Invalid)
}

fn nullable_count<'a>(o: &'a Obj, key: &str) -> Parsed<&'a Value> {
    o.get(key).filter(|value| value.is_number() || value.is_null()).ok_or(Invalid)
}

fn one_of<'a>(o: &'a Obj, key: &str, allowed: &[&str]) -> Parsed<&'a str> {
    text(o, key).and_then(|value| if allowed.contains(&value) { Ok(value) } else { Err(Invalid) })
}

fn boolean(o: &Obj, key: &str) -> Parsed<Option<bool>> {
    match o.get(key) {
        None => Ok(None),
        Some(value) => value.as_bool().map(Some).ok_or(Invalid),
    }
}

fn put(o: &mut Obj, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        o.insert(key.to_owned(), value);
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// `fromProviderExternalThreadName`: strips the `[bb] ` prefix bb adds to provider thread names.
pub fn thread_name(name: &str) -> &str {
    name.strip_prefix(BB_THREAD_NAME_PREFIX).unwrap_or(name)
}

/// Maps a Codex `codexErrorInfo` key to bb's provider error category.
pub fn error_category(provider_code: &str) -> Option<&'static str> {
    Some(match provider_code {
        "contextWindowExceeded" => "context-window-exceeded",
        "sessionBudgetExceeded" => "budget-exceeded",
        "usageLimitExceeded" => "rate-limit",
        "serverOverloaded" => "overloaded",
        "cyberPolicy" | "misalignmentPolicyViolation" => "policy",
        "internalServerError" => "internal",
        "unauthorized" => "unauthorized",
        "badRequest" => "bad-request",
        "threadRollbackFailed" => "thread-rollback-failed",
        "sandboxError" => "sandbox",
        "httpConnectionFailed" | "responseStreamConnectionFailed" => "connection-failed",
        "responseStreamDisconnected" => "stream-disconnected",
        "responseTooManyFailedAttempts" => "too-many-failed-attempts",
        "activeTurnNotSteerable" => "active-turn-not-steerable",
        _ => return None,
    })
}

/// Classifies a Codex `codexErrorInfo` value as `{ category, providerCode, httpStatusCode }`.
pub fn error_info(info: Option<&Value>) -> Option<Value> {
    let info = info.filter(|info| !info.is_null())?;
    let provider_code = match info {
        Value::Object(map) => map.keys().next().cloned(),
        other => Some(js_string(other)),
    };
    let detail = match (info, &provider_code) {
        (Value::Object(map), Some(code)) if !code.is_empty() => map.get(code),
        _ => None,
    };
    let status = detail.and_then(|detail| detail.get("httpStatusCode")).filter(|s| s.is_number());
    let category = error_category(provider_code.as_deref().unwrap_or("")).unwrap_or("unknown");
    Some(json!({
        "category": category,
        "providerCode": provider_code,
        "httpStatusCode": status.cloned().unwrap_or(Value::Null),
    }))
}

fn delta_channel(method: &str) -> Option<DeltaChannel> {
    Some(match method {
        "item/agentMessage/delta" => TextChannel::AgentMessage.into(),
        "item/reasoning/summaryTextDelta" => TextChannel::ReasoningSummary.into(),
        "item/reasoning/textDelta" => TextChannel::ReasoningText.into(),
        "item/plan/delta" => TextChannel::Plan.into(),
        "item/commandExecution/outputDelta" => DeltaChannel::Command,
        "item/fileChange/outputDelta" => DeltaChannel::FileChange,
        _ => return None,
    })
}

fn collab_labels(tool: &str) -> (String, String, String) {
    let [pending, completed, verb] = match tool {
        "spawnAgent" => ["Spawning agent", "Spawned agent", "Spawn agent"],
        "wait" => ["Waiting for agents", "Waited for agents", "Wait for agent"],
        "resumeAgent" => ["Resuming agent", "Resumed agent", "Resume agent"],
        "sendInput" => ["Messaging agent", "Messaged agent", "Send input to agent"],
        "closeAgent" => ["Closing agent", "Closed agent", "Close agent"],
        _ => return (format!("Running {tool}"), format!("Ran {tool}"), tool.to_owned()),
    };
    (pending.to_owned(), completed.to_owned(), verb.to_owned())
}

/// Presentations of injected dynamic tools by name; `None` falls back to the generic tool label.
pub type InjectedTools = HashMap<String, Option<Presentation>>;

/// What the translator needs from the session that owns it.
pub trait CodexTranslatorHooks: Send + Sync {
    /// The provider id of the session's root thread, once known.
    fn root_thread_id(&self) -> Option<String>;
    /// Called for every error Codex will not retry, with its category and detail text.
    fn on_terminal_error(&self, category: &str, detail: &str);
}

struct Translated {
    shape: Value,
    label: Presentation,
    status: &'static str,
    denied: bool,
}

enum Outcome {
    Item(Box<Translated>),
    Ignored,
    Unhandled,
}

fn done(shape: Value, label: Presentation, status: &str) -> Outcome {
    let mapped = match status {
        "inProgress" => "pending",
        "failed" => "failed",
        "declined" => "interrupted",
        _ => "completed",
    };
    let denied = status == "declined";
    Outcome::Item(Box::new(Translated { shape, label, status: mapped, denied }))
}

fn tool_call(tool: &str, server: Option<&str>, args: Option<&Value>) -> Obj {
    let mut shape = Obj::new();
    shape.insert("type".into(), "toolCall".into());
    put(&mut shape, "server", server.map(Value::from));
    shape.insert("tool".into(), tool.into());
    put(&mut shape, "arguments", args.filter(|args| args.is_object()).cloned());
    shape
}

fn duration(raw: &Obj) -> Parsed<Option<Value>> {
    let value = nullable_count(raw, "durationMs")?;
    Ok((!value.is_null()).then(|| value.clone()))
}

fn translate_item(raw: &Obj, injected: &InjectedTools) -> Parsed<Outcome> {
    let kind = text(raw, "type")?;
    let simple = |keys: &[&str], label: Presentation| -> Parsed<Outcome> {
        let mut shape = Obj::new();
        shape.insert("type".into(), kind.into());
        for key in keys {
            let value = raw.get(*key).ok_or(Invalid)?;
            match *key {
                "summary" | "content" => texts(value).map(drop)?,
                _ => value.as_str().map(drop).ok_or(Invalid)?,
            }
            shape.insert((*key).to_owned(), value.clone());
        }
        Ok(done(Value::Object(shape), label, "completed"))
    };
    match kind {
        "userMessage" => Ok(Outcome::Ignored),
        "agentMessage" => simple(&["text"], labels::message()),
        "reasoning" => simple(&["summary", "content"], labels::reasoning()),
        "plan" => simple(&["text"], labels::plan()),
        "contextCompaction" => simple(&[], labels::compaction()),
        "imageView" => simple(&["path"], labels::image_view(text(raw, "path")?)),
        "commandExecution" => {
            let line = text(raw, "command")?;
            let cwd = text(raw, "cwd")?;
            let output = nullable_text(raw, "aggregatedOutput")?;
            let status = one_of(raw, "status", &ITEM_STATUSES)?;
            let exit_code = nullable_count(raw, "exitCode")?;
            let mut shape = Obj::new();
            shape.insert("type".into(), kind.into());
            shape.insert("command".into(), line.into());
            shape.insert("cwd".into(), cwd.into());
            put(&mut shape, "aggregatedOutput", output.map(Value::from));
            put(&mut shape, "exitCode", (!exit_code.is_null()).then(|| exit_code.clone()));
            put(&mut shape, "durationMs", duration(raw)?);
            Ok(done(Value::Object(shape), labels::command(line), status))
        }
        "fileChange" => {
            let status = one_of(raw, "status", &ITEM_STATUSES)?;
            let list = raw.get("changes").and_then(Value::as_array).ok_or(Invalid)?;
            let mut changes = Vec::new();
            let mut paths = Vec::new();
            for change in list {
                let change = object(change)?;
                let path = text(change, "path")?;
                let diff = text(change, "diff")?;
                let kind_of = field(change, "kind")?;
                let change_kind = one_of(kind_of, "type", &["add", "delete", "update"])?;
                let move_path = nullish_text(kind_of, "move_path")?;
                let mut entry = Obj::new();
                entry.insert("path".into(), path.into());
                entry.insert("kind".into(), change_kind.into());
                let moved = non_empty(move_path).filter(|_| change_kind == "update");
                put(&mut entry, "movePath", moved.map(Value::from));
                put(&mut entry, "diff", non_empty(Some(diff)).map(Value::from));
                changes.push(Value::Object(entry));
                paths.push(path);
            }
            let shape = json!({ "type": kind, "changes": changes });
            Ok(done(shape, labels::file_change(&paths), status))
        }
        "mcpToolCall" => {
            let status = one_of(raw, "status", &ITEM_STATUSES)?;
            let tool = text(raw, "tool")?;
            let server = text(raw, "server")?;
            let error = match raw.get("error") {
                None | Some(Value::Null) => None,
                Some(error) => optional_text(object(error)?, "message")?,
            };
            let mut shape = tool_call(tool, Some(server), raw.get("arguments"));
            put(&mut shape, "error", error.map(Value::from));
            put(&mut shape, "durationMs", duration(raw)?);
            Ok(done(Value::Object(shape), labels::tool(tool, Some(server)), status))
        }
        "dynamicToolCall" => {
            let status = one_of(raw, "status", &ITEM_STATUSES)?;
            let tool = text(raw, "tool")?;
            let success = raw.get("success").ok_or(Invalid)?;
            if !success.is_null() && !success.is_boolean() {
                return Err(Invalid);
            }
            let items = match raw.get("contentItems").ok_or(Invalid)? {
                Value::Null => Vec::new(),
                Value::Array(items) => items.iter().map(object).collect::<Parsed<Vec<_>>>()?,
                _ => return Err(Invalid),
            };
            let mut parts = Vec::new();
            for item in items {
                let part = match (optional_text(item, "text")?, optional_text(item, "imageUrl")?) {
                    (Some(text), _) => text.to_owned(),
                    (None, Some(url)) if !url.is_empty() => format!("[image: {url}]"),
                    _ => String::new(),
                };
                if !part.trim().is_empty() {
                    parts.push(part);
                }
            }
            let result = (!parts.is_empty()).then(|| parts.join("\n"));
            let error = (success == &Value::Bool(false))
                .then(|| result.clone().unwrap_or_else(|| "Dynamic tool call failed".to_owned()));
            let server = injected.contains_key(tool).then_some("bb");
            let mut shape = tool_call(tool, server, raw.get("arguments"));
            put(&mut shape, "result", result.map(Value::from));
            put(&mut shape, "error", error.map(Value::from));
            put(&mut shape, "durationMs", duration(raw)?);
            let label = injected.get(tool).cloned().flatten();
            let label = label.unwrap_or_else(|| labels::tool(tool, None));
            Ok(done(Value::Object(shape), label, status))
        }
        "collabAgentToolCall" => {
            let sender = text(raw, "senderThreadId")?;
            let receivers = texts(raw.get("receiverThreadIds").ok_or(Invalid)?)?;
            let prompt = nullable_text(raw, "prompt")?;
            let model = nullable_text(raw, "model")?;
            let states = field(raw, "agentsStates")?;
            let tool = text(raw, "tool")?;
            let status = one_of(raw, "status", &ITEM_STATUSES)?;
            let effort = nullable_text(raw, "reasoningEffort")?;
            let (pending, completed, verb) = collab_labels(tool);
            let label = presentation(&pending, &completed, "UserRound", prompt);
            if let Some(child) = receivers.first().filter(|child| !child.is_empty()) {
                let lines: Vec<String> = states
                    .iter()
                    .map(|(id, state)| match state {
                        Value::String(state) => format!("{id}: {state}"),
                        other => format!("{id}: {other}"),
                    })
                    .collect();
                let settled = status != "inProgress" && !lines.is_empty();
                let name = non_empty(prompt.map(str::trim)).unwrap_or(&verb);
                let mut shape = Obj::new();
                shape.insert("type".into(), "delegation".into());
                shape.insert("childRef".into(), (*child).into());
                shape.insert("label".into(), name.into());
                shape.insert("background".into(), false.into());
                put(&mut shape, "summary", settled.then(|| lines.join("\n").into()));
                return Ok(done(Value::Object(shape), label, status));
            }
            let mut input = Obj::new();
            input.insert("senderThreadId".into(), sender.into());
            input.insert("receiverThreadIds".into(), json!(receivers));
            put(&mut input, "prompt", non_empty(prompt).map(Value::from));
            put(&mut input, "model", non_empty(model).map(Value::from));
            put(&mut input, "reasoningEffort", non_empty(effort).map(Value::from));
            let shape = json!({
                "type": "toolCall",
                "tool": tool,
                "arguments": input,
                "result": states,
            });
            Ok(done(shape, label, status))
        }
        "webSearch" => {
            let query = text(raw, "query")?;
            let action = match raw.get("action").ok_or(Invalid)? {
                Value::Null => return Ok(Outcome::Ignored),
                action => object(action)?,
            };
            let action_type = text(action, "type")?;
            let action_query = nullish_text(action, "query")?;
            let queries = match action.get("queries") {
                None | Some(Value::Null) => Vec::new(),
                Some(list) => texts(list)?,
            };
            let url = nullish_text(action, "url")?;
            let pattern = nullish_text(action, "pattern")?;
            if action_type == "other" {
                return Ok(Outcome::Ignored);
            }
            if action_type == "search" {
                let mut unique: Vec<&str> = Vec::new();
                let candidates = queries.into_iter().chain(action_query).chain(Some(query));
                for candidate in candidates.filter(|q| !q.is_empty()) {
                    if !unique.contains(&candidate) {
                        unique.push(candidate);
                    }
                }
                let Some(first) = unique.first() else { return Ok(Outcome::Unhandled) };
                let label = labels::web_search(Some(first));
                let shape = json!({ "type": kind, "queries": unique, "resultText": null });
                return Ok(done(shape, label, "completed"));
            }
            let Some(url) = non_empty(url) else { return Ok(Outcome::Unhandled) };
            let found = if action_type == "findInPage" { pattern } else { None };
            let shape = json!({
                "type": "webFetch",
                "url": url,
                "prompt": null,
                "resultText": null,
                "pattern": found,
            });
            Ok(done(shape, labels::web_fetch(url), "completed"))
        }
        _ => Ok(Outcome::Unhandled),
    }
}

fn usage_of(o: &Obj) -> Parsed<Value> {
    let mut usage = Obj::new();
    for key in USAGE_FIELDS {
        match o.get(key) {
            None if key == "cacheWriteInputTokens" => {}
            value => {
                let value = value.filter(|v| v.is_number()).ok_or(Invalid)?;
                let negative = value.as_f64().is_some_and(|n| n < 0.0);
                if negative && key.starts_with("cache") {
                    return Err(Invalid);
                }
                usage.insert(key.to_owned(), value.clone());
            }
        }
    }
    let cached = usage.get("cachedInputTokens").cloned().unwrap_or(Value::Null);
    usage.insert("cacheReadInputTokens".into(), cached);
    Ok(Value::Object(usage))
}

#[derive(Clone, Debug)]
struct TrackedAgent {
    call_id: String,
    agent_thread_id: String,
    agent_path: String,
    turn: String,
    parent_ref: Option<String>,
    open: bool,
}

/// Translates `codex app-server` notifications into canonical thread events. Unknown or
/// malformed traffic is dropped, never an error.
pub struct CodexTranslator {
    events: Arc<EventBuilder>,
    injected: InjectedTools,
    hooks: Arc<dyn CodexTranslatorHooks>,
    awaiting_replayed_usage: bool,
    retry_errors: HashMap<String, (Value, String)>,
    agents: IndexMap<String, TrackedAgent>,
    parent_by_thread: HashMap<String, String>,
    parent_by_turn: HashMap<String, String>,
}

impl CodexTranslator {
    /// `awaiting_replayed_usage` is true for a resumed thread: token usage Codex replays before
    /// the first turn opens only updates the context window.
    pub fn new(
        events: Arc<EventBuilder>,
        injected: InjectedTools,
        hooks: Arc<dyn CodexTranslatorHooks>,
        awaiting_replayed_usage: bool,
    ) -> Self {
        Self {
            events,
            injected,
            hooks,
            awaiting_replayed_usage,
            retry_errors: HashMap::new(),
            agents: IndexMap::new(),
            parent_by_thread: HashMap::new(),
            parent_by_turn: HashMap::new(),
        }
    }

    /// Feeds one notification; returns false when it was dropped as unknown or malformed.
    pub fn handle(&mut self, method: &str, params: &Value) -> bool {
        self.dispatch(method, params).unwrap_or(false)
    }

    pub fn open_turn(&mut self, thread_id: &str, turn: &str) {
        self.awaiting_replayed_usage = false;
        if let Some(index) = self.agent_of(thread_id).filter(|i| !self.agents[*i].open) {
            self.set_agent(index, "pending");
        }
        let parent_ref = self.parent_ref(thread_id, turn);
        if let Some(parent) = &parent_ref {
            self.parent_by_turn.insert(turn.to_owned(), parent.clone());
        }
        self.events.open_turn(Some(turn), parent_ref.as_deref());
    }

    /// Closes a turn from a Codex `Turn` object (`{ id, status, error? }`); a still
    /// `inProgress` status counts as completed.
    pub fn close_turn(&mut self, thread_id: &str, turn: &Value) -> bool {
        let Ok((id, status, error)) = Self::turn_of(turn) else { return false };
        self.close_turn_with(thread_id, &id, &status, error.as_deref());
        true
    }

    pub fn close_turn_with(
        &mut self,
        thread_id: &str,
        turn: &str,
        status: &str,
        error: Option<&str>,
    ) {
        self.retry_errors.remove(&format!("{thread_id}\0{turn}"));
        let status = if status == "inProgress" { "completed" } else { status };
        self.events.close_turn(Some(turn), status, non_empty(error), Some(turn));
        let parent = self.parent_by_turn.get(turn).cloned().unwrap_or_default();
        if let Some(index) = self.agents.get_index_of(&parent).filter(|i| self.agents[*i].open) {
            self.set_agent(index, status);
        }
    }

    /// Parses a Codex `Turn` into `(id, status, error message)`.
    pub fn parse_turn(turn: &Value) -> Option<(String, String, Option<String>)> {
        Self::turn_of(turn).ok()
    }

    fn turn_of(turn: &Value) -> Parsed<(String, String, Option<String>)> {
        let turn = object(turn)?;
        let id = text(turn, "id")?;
        let status = one_of(turn, "status", &TURN_STATUSES)?;
        let error = match turn.get("error") {
            None | Some(Value::Null) => None,
            Some(error) => Some(Self::error_of(object(error)?)?.0.to_owned()),
        };
        Ok((id.to_owned(), status.to_owned(), error))
    }

    fn error_of(error: &Obj) -> Parsed<(&str, Option<&str>)> {
        let message = text(error, "message")?;
        Ok((message, nullish_text(error, "additionalDetails")?))
    }

    /// Fails every open sub-agent (of `thread_id`, or all); returns whether any was open.
    pub fn close_agents(&mut self, thread_id: Option<&str>) -> bool {
        let open: Vec<usize> = (0..self.agents.len())
            .filter(|i| {
                let agent = &self.agents[*i];
                agent.open && thread_id.is_none_or(|id| agent.agent_thread_id == id)
            })
            .collect();
        for index in &open {
            self.set_agent(*index, "failed");
        }
        !open.is_empty()
    }

    fn parent_ref(&self, thread_id: &str, turn: &str) -> Option<String> {
        self.parent_by_turn.get(turn).or_else(|| self.parent_by_thread.get(thread_id)).cloned()
    }

    fn agent_of(&self, thread_id: &str) -> Option<usize> {
        self.agents.values().position(|agent| agent.agent_thread_id == thread_id)
    }

    fn set_agent(&mut self, index: usize, status: &str) {
        let agent = &mut self.agents[index];
        agent.open = status == "pending";
        let agent = agent.clone();
        let key = ItemKey::provider(&agent.call_id).with_parent_ref(agent.parent_ref.clone());
        let shape = json!({
            "type": "delegation",
            "label": agent.agent_path,
            "background": false,
            "childRef": agent.agent_thread_id,
        });
        let presentation = Some(labels::agent(&agent.agent_path));
        let turn = Some(agent.turn.clone());
        if status == "pending" {
            self.events.open_item(&key, shape, ItemOptions { turn, presentation });
        } else {
            let options =
                CloseOptions { turn, status: status.to_owned(), presentation, denied: false };
            self.events.close_item(&key, shape, options);
        }
    }

    fn activity(&mut self, thread_id: &str, turn: &str, call_id: &str, item: &Obj) -> Parsed<()> {
        let kind = one_of(item, "kind", &ACTIVITY_KINDS)?;
        let agent_thread_id = text(item, "agentThreadId")?;
        let agent_path = text(item, "agentPath")?;
        let tracked = self.agent_of(agent_thread_id);
        if let Some(index) = tracked.filter(|i| kind == "interrupted" && self.agents[*i].open) {
            self.set_agent(index, "interrupted");
        }
        if kind != "started" || self.agents.contains_key(call_id) {
            return Ok(());
        }
        let agent = TrackedAgent {
            call_id: call_id.to_owned(),
            agent_thread_id: agent_thread_id.to_owned(),
            agent_path: agent_path.to_owned(),
            turn: turn.to_owned(),
            parent_ref: self.parent_ref(thread_id, turn),
            open: false,
        };
        self.agents.insert(call_id.to_owned(), agent);
        self.parent_by_thread.insert(agent_thread_id.to_owned(), call_id.to_owned());
        let index = self.agents.len() - 1;
        self.set_agent(index, "pending");
        Ok(())
    }

    fn item(&mut self, method: &str, params: &Obj) -> Parsed<bool> {
        let thread_id = text(params, "threadId")?;
        let turn = text(params, "turnId")?;
        let raw = field(params, "item")?;
        text(raw, "type")?;
        let id = text(raw, "id")?;
        let closing = method == "item/completed";
        let parent_ref = self.parent_ref(thread_id, turn);
        if raw.get("type").and_then(Value::as_str) == Some("subAgentActivity") {
            if one_of(raw, "kind", &ACTIVITY_KINDS).is_ok()
                && text(raw, "agentThreadId").is_ok()
                && text(raw, "agentPath").is_ok()
            {
                if closing {
                    self.activity(thread_id, turn, id, raw)?;
                }
                return Ok(true);
            }
            return Ok(false);
        }
        let translated = match translate_item(raw, &self.injected) {
            Ok(Outcome::Item(translated)) => translated,
            Ok(Outcome::Ignored) => return Ok(true),
            Ok(Outcome::Unhandled) | Err(Invalid) => return Ok(false),
        };
        let key = ItemKey::provider(id).with_parent_ref(parent_ref);
        let Translated { shape, label, status, denied } = *translated;
        let delegated = (shape["type"] == "delegation").then(|| shape["childRef"].as_str());
        if let Some(Some(child)) = delegated.filter(|child| *child != Some(thread_id)) {
            self.parent_by_thread.insert(child.to_owned(), id.to_owned());
        }
        let turn = Some(turn.to_owned());
        if closing {
            let status = status.to_owned();
            let options = CloseOptions { turn, status, presentation: Some(label), denied };
            self.events.close_item(&key, shape, options);
        } else {
            self.events.open_item(&key, shape, ItemOptions { turn, presentation: Some(label) });
        }
        Ok(true)
    }

    fn delta(&mut self, method: &str, params: &Obj) -> Parsed<bool> {
        let Some(channel) = delta_channel(method) else { return Ok(false) };
        let thread_id = text(params, "threadId")?;
        let turn = text(params, "turnId")?;
        let item_id = text(params, "itemId")?;
        let delta = text(params, "delta")?;
        let key = ItemKey::provider(item_id).with_parent_ref(self.parent_ref(thread_id, turn));
        self.events.delta(&key, channel, delta, Some(turn));
        Ok(true)
    }

    fn failure(&mut self, params: &Obj) -> Parsed<()> {
        let thread_id = text(params, "threadId")?;
        let turn = optional_text(params, "turnId")?;
        let error = field(params, "error")?;
        let (message, details) = Self::error_of(error)?;
        let will_retry = boolean(params, "willRetry")?;
        let failure = details.unwrap_or(message);
        let key = format!("{thread_id}\0{}", turn.unwrap_or(""));
        let mut info = error.get("codexErrorInfo").cloned();
        let other = Value::from("other");
        if will_retry == Some(true) {
            if let Some(retried) = info.clone().filter(|i| truthy(i) && *i != other) {
                self.retry_errors.insert(key, (retried, failure.to_owned()));
            }
        } else if will_retry == Some(false) {
            let retried = self.retry_errors.remove(&key);
            let inherits = info.as_ref() == Some(&other);
            if let Some((retried_info, _)) = retried.filter(|(_, text)| inherits && text == failure)
            {
                info = Some(retried_info);
            }
        }
        let detail = [Some(message), details].into_iter().flatten().filter(|s| !s.is_empty());
        let detail = detail.collect::<Vec<_>>().join("\n");
        let classified = error_info(info.as_ref());
        let mut report = Obj::new();
        report.insert("detail".into(), detail.clone().into());
        put(&mut report, "willRetry", will_retry.map(Value::from));
        put(&mut report, "errorInfo", classified.clone());
        let options = ErrorOptions {
            turn: turn.map(str::to_owned),
            settles_turn: false,
            thread_scoped: turn.is_none(),
        };
        self.events.error(Value::Object(report), options);
        let category = classified.as_ref().and_then(|c| c["category"].as_str());
        if will_retry != Some(true) {
            self.hooks.on_terminal_error(category.unwrap_or("unknown"), &detail);
        }
        Ok(())
    }

    fn usage(&mut self, params: &Obj) -> Parsed<()> {
        let turn_id = text(params, "turnId")?;
        let token_usage = field(params, "tokenUsage")?;
        let total = usage_of(field(token_usage, "total")?)?;
        let last = usage_of(field(token_usage, "last")?)?;
        let window = nullable_count(token_usage, "modelContextWindow")?.clone();
        let turn = non_empty((!self.awaiting_replayed_usage).then_some(turn_id));
        let used = last["totalTokens"].clone();
        if turn.is_some() {
            let usage = json!({ "total": total, "last": last, "modelContextWindow": window });
            self.events.usage(usage, turn);
        }
        let context =
            json!({ "usedTokens": used, "modelContextWindow": window, "estimated": false });
        self.events.context_window(context, turn, false);
        Ok(())
    }

    fn plan(&mut self, params: &Obj) -> Parsed<()> {
        let turn = text(params, "turnId")?;
        let explanation = nullish_text(params, "explanation")?;
        let list = params.get("plan").and_then(Value::as_array).ok_or(Invalid)?;
        let mut steps = Vec::new();
        let mut active = None;
        for entry in list {
            let entry = object(entry)?;
            let step = text(entry, "step")?;
            let status = match one_of(entry, "status", &STEP_STATUSES)? {
                "inProgress" => "active",
                other => other,
            };
            if status == "active" && active.is_none() {
                active = Some(step);
            }
            steps.push(json!({ "step": step, "status": status }));
        }
        let presentation = Some(labels::plan_steps(active.or(explanation)));
        let mut item = Obj::new();
        item.insert("type".into(), "planSteps".into());
        item.insert("steps".into(), steps.into());
        put(&mut item, "explanation", non_empty(explanation).map(Value::from));
        let key = ItemKey::default().with_channel("planSteps");
        let turn = Some(turn.to_owned());
        let status = "completed".to_owned();
        let options = CloseOptions { turn, status, presentation, denied: false };
        self.events.close_item(&key, Value::Object(item), options);
        Ok(())
    }

    fn is_root(&self, thread_id: &str) -> bool {
        self.hooks.root_thread_id().is_none_or(|root| root == thread_id)
    }

    fn dispatch(&mut self, method: &str, params: &Value) -> Parsed<bool> {
        if method == "thread/goal/cleared" {
            self.events.extension_state(GOAL_KIND, Value::Null);
            return Ok(true);
        }
        let params = object(params)?;
        let events = Arc::clone(&self.events);
        match method {
            "item/started" | "item/completed" => return self.item(method, params),
            "turn/started" | "turn/completed" => {
                let thread_id = text(params, "threadId")?;
                let (id, status, error) = Self::turn_of(params.get("turn").ok_or(Invalid)?)?;
                if method == "turn/started" {
                    self.open_turn(thread_id, &id);
                } else {
                    self.close_turn_with(thread_id, &id, &status, error.as_deref());
                }
            }
            "thread/started" => {
                let thread = field(params, "thread")?;
                let id = text(thread, "id").and_then(non_empty_ok)?;
                let preview = optional_text(thread, "preview")?;
                if self.is_root(id) {
                    events.started();
                    events.identity(id);
                    if let Some(preview) = non_empty(preview) {
                        events.name(thread_name(preview));
                    }
                }
            }
            "thread/name/updated" => {
                let thread_id = text(params, "threadId")?;
                let name = optional_text(params, "threadName")?;
                if let Some(name) = non_empty(name).filter(|_| self.is_root(thread_id)) {
                    events.name(thread_name(name));
                }
            }
            "thread/compacted" => {
                text(params, "threadId")?;
                events.compacted(Some(text(params, "turnId")?));
            }
            "thread/goal/updated" => {
                let goal = field(params, "goal")?;
                let goal = json!({
                    "objective": text(goal, "objective")?,
                    "status": one_of(goal, "status", &GOAL_STATUSES)?,
                    "tokenBudget": nullable_count(goal, "tokenBudget")?,
                    "tokensUsed": count(goal, "tokensUsed")?,
                    "timeUsedSeconds": count(goal, "timeUsedSeconds")?,
                });
                events.extension_state(GOAL_KIND, goal);
            }
            "thread/closed" => return Ok(self.close_agents(Some(text(params, "threadId")?))),
            "item/mcpToolCall/progress" => {
                let thread_id = text(params, "threadId")?;
                let turn = text(params, "turnId")?;
                let item_id = text(params, "itemId")?;
                let message = optional_text(params, "message")?;
                let parent_ref = self.parent_ref(thread_id, turn);
                let key = ItemKey::provider(item_id).with_parent_ref(parent_ref);
                let options = ProgressOptions {
                    turn: Some(turn.to_owned()),
                    message: non_empty(message).map(str::to_owned),
                    ..ProgressOptions::default()
                };
                events.progress(&key, options);
            }
            "thread/tokenUsage/updated" => self.usage(params)?,
            "turn/plan/updated" => self.plan(params)?,
            "error" => self.failure(params)?,
            "deprecationNotice" | "configWarning" => {
                let category = if method == "configWarning" { "config" } else { "deprecation" };
                let summary = text(params, "summary")?;
                let details = nullish_text(params, "details")?;
                let mut warning = Obj::new();
                warning.insert("category".into(), category.into());
                warning.insert("summary".into(), summary.into());
                put(&mut warning, "details", non_empty(details).map(Value::from));
                events.warning(Value::Object(warning));
            }
            "warning" => events.warning(json!({ "summary": text(params, "message")? })),
            _ => return self.delta(method, params),
        }
        Ok(true)
    }
}

fn non_empty_ok(value: &str) -> Parsed<&str> {
    if value.is_empty() { Err(Invalid) } else { Ok(value) }
}
