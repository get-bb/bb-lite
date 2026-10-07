use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use bb_provider::{
    BackgroundSnapshot, CloseOptions, DeltaChannel, ErrorOptions, EventBuilder, ItemKey,
    ItemOptions, Presentation, ProgressOptions, TextChannel, TokenUsage, ZERO_TOKEN_USAGE,
    add_token_usage, labels, presentation,
};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::tools::{self, ClassifiedTool, PlanStep, TaskPlan, ToolContext, text as str_of};

const LARGE_CONTEXT_MODELS: [&str; 6] =
    ["best", "claude-fable-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-5-1", "fable"];
const TASK_TYPES: [&str; 4] = ["local_workflow", "local_bash", "local_agent", "local_subagent"];
static FALLBACK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^model_(refusal_)?fallback$").expect("regex"));

#[derive(Clone, Debug, Default)]
struct Turn {
    id: String,
    responded: bool,
    compacting: bool,
    request_tokens: Option<f64>,
    checkpoint: Option<String>,
    fallback: Option<String>,
}

#[derive(Clone, Debug)]
struct Task {
    key: ItemKey,
    generation: u32,
    done: bool,
    item: Map<String, Value>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Usage {
    input: Option<f64>,
    output: Option<f64>,
    cache_read: Option<f64>,
    cache_write: Option<f64>,
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

fn number_field(value: &Value, key: &str, nonnegative: bool) -> Result<Option<f64>, ()> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::Number(n)) => {
            let n = n.as_f64().ok_or(())?;
            if nonnegative && n < 0.0 { Err(()) } else { Ok(Some(n)) }
        }
        Some(_) => Err(()),
    }
}

fn parse_usage(value: Option<&Value>) -> Option<Usage> {
    let value = value.filter(|v| v.is_object())?;
    Some(Usage {
        input: number_field(value, "input_tokens", false).ok()?,
        output: number_field(value, "output_tokens", false).ok()?,
        cache_read: number_field(value, "cache_read_input_tokens", true).ok()?,
        cache_write: number_field(value, "cache_creation_input_tokens", true).ok()?,
    })
}

fn blocks_of(message: Option<&Value>) -> Vec<Value> {
    let content = message.and_then(|m| m.get("content")).and_then(Value::as_array);
    let valid =
        |blocks: &Vec<Value>| blocks.iter().all(|b| b.get("type").is_some_and(Value::is_string));
    content.filter(|blocks| valid(blocks)).cloned().unwrap_or_default()
}

fn tokens(value: Option<f64>) -> f64 {
    value.filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(0.0)
}

fn num(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

fn js_number(value: f64) -> String {
    num(value).to_string()
}

pub fn context_window_hint(model: &str) -> Option<u64> {
    if LARGE_CONTEXT_MODELS.contains(&model) || model.ends_with("[1m]") {
        return Some(1_000_000);
    }
    (model != "default").then_some(200_000)
}

fn reported_context_window(model_usage: Option<&Value>) -> Option<f64> {
    let usage = model_usage.and_then(Value::as_object)?;
    let windows: Option<Vec<(&String, f64)>> = usage
        .iter()
        .map(|(model, entry)| Some((model, entry.get("contextWindow")?.as_f64()?)))
        .collect();
    windows?
        .into_iter()
        .filter(|(_, reported)| reported.is_finite() && *reported > 0.0)
        .map(|(model, reported)| reported.max(context_window_hint(model).unwrap_or(0) as f64))
        .reduce(f64::max)
}

fn http_category(status: f64) -> &'static str {
    match status {
        402.0 => "billing",
        401.0 | 403.0 => "unauthorized",
        429.0 => "rate-limit",
        529.0 => "overloaded",
        s if (400.0..500.0).contains(&s) => "bad-request",
        s if (500.0..600.0).contains(&s) => "internal",
        _ => "unknown",
    }
}

fn error_category(code: &str) -> Option<&'static str> {
    Some(match code {
        "authentication_failed" | "oauth_org_not_allowed" => "unauthorized",
        "billing_error" => "billing",
        "rate_limit" => "rate-limit",
        "invalid_request" | "model_not_found" => "bad-request",
        "server_error" => "internal",
        "max_output_tokens" => "max-output-tokens",
        "unknown" | "error_during_execution" => "unknown",
        "error_max_turns" => "max-turns",
        "error_max_budget_usd" => "budget-exceeded",
        "error_max_structured_output_retries" => "structured-output-retries",
        _ => return None,
    })
}

/// The `ProviderErrorInfo` for an HTTP status, an error code and a result subtype, or `None`.
pub fn error_info(status: Option<f64>, code: Option<&str>, subtype: Option<&str>) -> Option<Value> {
    let from_code = code.and_then(error_category);
    let from_status = status.map(http_category);
    let from_subtype = subtype.and_then(error_category);
    let overloaded = from_code.is_some() && status == Some(529.0);
    let mapped = if from_code == Some("unknown") { from_status } else { from_code.or(from_status) };
    let category = if overloaded { Some("overloaded") } else { mapped.or(from_subtype) };
    let provider_code = code.or(from_subtype.and(subtype));
    if category.is_none() && provider_code.is_none() && status.is_none() {
        return None;
    }
    Some(json!({
        "category": category.unwrap_or("unknown"),
        "providerCode": provider_code,
        "httpStatusCode": status.map(num),
    }))
}

fn item_status(task_status: &str) -> &'static str {
    match task_status {
        "completed" => "completed",
        "failed" | "killed" => "failed",
        "stopped" => "interrupted",
        _ => "pending",
    }
}

fn field<'a>(item: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    item.get(key).and_then(Value::as_str)
}

fn set_or_remove(item: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => item.insert(key.to_owned(), value),
        None => item.shift_remove(key),
    };
}

/// Turns the messages the Claude Code CLI writes on stdout into thread events. Unknown or
/// malformed traffic is ignored, never an error.
pub struct ClaudeTranslator {
    events: Arc<EventBuilder>,
    context: ToolContext,
    turn: Turn,
    total: TokenUsage,
    context_window: Option<f64>,
    suppressed: bool,
    parent_ref: Option<String>,
    tools: HashMap<String, ClassifiedTool>,
    tasks: indexmap::IndexMap<String, Task>,
    plan: TaskPlan,
}

impl ClaudeTranslator {
    pub fn new(events: Arc<EventBuilder>, context: ToolContext) -> Self {
        Self {
            events,
            context,
            turn: Turn::default(),
            total: ZERO_TOKEN_USAGE,
            context_window: None,
            suppressed: false,
            parent_ref: None,
            tools: HashMap::new(),
            tasks: indexmap::IndexMap::new(),
            plan: TaskPlan::new(),
        }
    }

    pub fn set_model(&mut self, model: &str) {
        self.context_window = context_window_hint(model).map(|w| w as f64);
    }

    pub fn accept_input(&mut self) {
        self.suppressed = false;
    }

    pub fn stop_tasks(&mut self) {
        let ids: Vec<String> = self.tasks.keys().cloned().collect();
        for id in ids {
            let Some(task) = self.tasks.get(&id) else { continue };
            if task.done {
                continue;
            }
            let status = field(&task.item, "taskStatus").unwrap_or("").to_owned();
            let live = item_status(&status) == "pending";
            self.close_task(&id, if live { "stopped" } else { &status });
        }
    }

    /// Translates one message; returns whether it was understood (TypeScript logs the rest).
    pub fn handle(&mut self, raw: &Value) -> bool {
        if !raw.is_object() {
            return false;
        }
        self.parent_ref = non_empty(str_of(raw.get("parent_tool_use_id"))).map(str::to_owned);
        let kind = str_of(raw.get("type")).unwrap_or("unknown");
        self.dispatch(raw, kind)
    }

    fn dispatch(&mut self, message: &Value, kind: &str) -> bool {
        match kind {
            "assistant" => return self.assistant(message),
            "user" => return self.user(message),
            "stream_event" => return self.stream(message),
            "result" => return self.result(message),
            _ => {}
        }
        if kind == "conversation_reset" && !self.blocked() {
            self.ensure_turn();
            self.events.cleared();
        }
        if kind != "system" {
            return kind == "conversation_reset";
        }
        self.system(message, str_of(message.get("subtype")).unwrap_or(""))
    }

    fn blocked(&self) -> bool {
        self.suppressed && self.events.active_turn_id().is_none()
    }

    fn active_turn(&mut self) -> bool {
        let Some(id) = self.events.active_turn_id() else { return false };
        if self.turn.id != id {
            self.turn = Turn { id, ..Turn::default() };
            self.tools.clear();
        }
        true
    }

    fn ensure_turn(&mut self) -> &mut Turn {
        if self.events.active_turn_id().is_none() {
            self.events.open_turn(None, None);
        }
        self.active_turn();
        self.turn.responded = true;
        &mut self.turn
    }

    fn has_blocking_tasks(&self) -> bool {
        self.tasks.values().any(|Task { done, item, .. }| {
            let agent = matches!(field(item, "taskType"), Some("local_agent" | "local_subagent"));
            !done && item.get("skipTranscript") != Some(&Value::Bool(true)) && agent
        })
    }

    fn say(&self, channel: TextChannel, value: &str, last: bool) {
        let name = if channel == TextChannel::ReasoningText { "thinking" } else { "assistant" };
        let key = ItemKey {
            provider_item_id: None,
            channel: Some(name.to_owned()),
            parent_ref: self.parent_ref.clone(),
        };
        if last {
            self.events.text_close(&key, channel, Some(value), None);
        } else {
            self.events.delta(&key, DeltaChannel::Text(channel), value, None);
        }
    }

    fn plan_steps(&self, steps: &[PlanStep]) {
        let active =
            steps.iter().find(|step| step.status == "active").map(|step| step.step.as_str());
        let presentation = Presentation { suppress: Some(true), ..labels::plan_steps(active) };
        let options =
            CloseOptions { presentation: Some(presentation), ..CloseOptions::new("completed") };
        let key = ItemKey {
            provider_item_id: None,
            channel: Some("planSteps".to_owned()),
            parent_ref: self.parent_ref.clone(),
        };
        self.events.close_item(&key, json!({ "type": "planSteps", "steps": steps }), options);
    }

    fn report_context(&self, used: Option<f64>, window: Option<f64>, open_only: bool) {
        let usage = json!({ "usedTokens": used.map(num), "modelContextWindow": window.map(num), "estimated": true });
        self.events.context_window(usage, None, open_only);
    }

    fn assistant(&mut self, message: &Value) -> bool {
        if self.blocked() {
            return true;
        }
        let body = message.get("message").filter(|b| b.is_object());
        let content = blocks_of(body);
        let said: Vec<&str> = content
            .iter()
            .filter(|b| str_of(b.get("type")) == Some("text"))
            .filter_map(|b| str_of(b.get("text")))
            .collect();
        let joined = said.join("\n");
        let reply = joined.trim();
        let usage = parse_usage(body.and_then(|b| b.get("usage")));
        let top = self.parent_ref.is_none();
        let model = body.and_then(|b| str_of(b.get("model")));
        let silent = model == Some("<synthetic>") && reply == "No response requested.";
        if silent && self.events.active_turn_id().is_none() {
            return true;
        }
        let uuid = non_empty(str_of(message.get("uuid"))).map(str::to_owned);
        let turn = self.ensure_turn();
        if top && uuid.is_some() {
            turn.checkpoint = uuid;
        }
        if silent {
            let checkpoint = self.turn.checkpoint.clone();
            if !self.has_blocking_tasks() {
                self.events.close_turn(None, "completed", None, checkpoint.as_deref());
            }
            return true;
        }
        if let (true, Some(usage)) = (top, usage) {
            let request =
                tokens(usage.input) + tokens(usage.cache_read) + tokens(usage.cache_write);
            self.turn.request_tokens = Some(request);
            self.report_context(Some(request), self.context_window, true);
        }
        for block in &content {
            if let (Some("thinking"), Some(thinking)) =
                (str_of(block.get("type")), non_empty(str_of(block.get("thinking"))))
            {
                self.say(TextChannel::ReasoningText, thinking, true);
            }
        }
        if !reply.is_empty() {
            self.say(TextChannel::AgentMessage, reply, true);
        }
        for block in &content {
            let (id, name) = (str_of(block.get("id")), str_of(block.get("name")));
            let (true, Some(id), Some(name)) =
                (str_of(block.get("type")) == Some("tool_use"), id, name)
            else {
                continue;
            };
            let input = block.get("input").unwrap_or(&Value::Null);
            let tool = tools::classify_tool(name, id, input, &self.context);
            self.tools.insert(id.to_owned(), tool.clone());
            let key = ItemKey {
                provider_item_id: Some(id.to_owned()),
                channel: None,
                parent_ref: self.parent_ref.clone(),
            };
            let options =
                ItemOptions { presentation: Some(tool.presentation), ..ItemOptions::default() };
            self.events.open_item(&key, tool.shape, options);
            if let Some(steps) = tool.plan_steps {
                self.plan_steps(&steps);
            }
        }
        true
    }

    fn stream(&mut self, message: &Value) -> bool {
        let event = message.get("event").filter(|e| e.is_object()).cloned().unwrap_or(json!({}));
        let kind = str_of(event.get("type"));
        let delta = kind == Some("content_block_delta");
        let start = kind == Some("content_block_start");
        let part =
            event.get(if delta { "delta" } else { "content_block" }).filter(|p| p.is_object());
        let Some(part) = part.filter(|_| delta || start) else { return true };
        let suffix = if delta { "_delta" } else { "" };
        let kind = str_of(part.get("type")).unwrap_or("");
        let thought = (kind == format!("thinking{suffix}"))
            .then(|| non_empty(str_of(part.get("thinking"))))
            .flatten();
        let said = (kind == format!("text{suffix}"))
            .then(|| non_empty(str_of(part.get("text"))))
            .flatten();
        if (thought.is_none() && said.is_none()) || self.blocked() {
            return true;
        }
        self.ensure_turn();
        if let Some(thought) = thought {
            self.say(TextChannel::ReasoningText, thought, false);
        }
        if let Some(said) = said {
            self.say(TextChannel::AgentMessage, said, false);
        }
        true
    }

    fn user(&mut self, message: &Value) -> bool {
        let blocks = blocks_of(message.get("message"));
        let results: Vec<&Value> = blocks
            .iter()
            .filter(|b| {
                str_of(b.get("type")) == Some("tool_result")
                    && non_empty(str_of(b.get("tool_use_id"))).is_some()
            })
            .collect();
        let has_turn = self.active_turn();
        if results.is_empty() {
            let nested = message.get("parent_tool_use_id").is_some_and(|p| !p.is_null());
            let prompt = message.get("isSynthetic") != Some(&Value::Bool(true)) && !nested;
            if has_turn && prompt && self.turn.checkpoint.is_none() {
                self.turn.checkpoint = str_of(message.get("uuid")).map(str::to_owned);
            }
            let narrated = blocks.iter().all(|b| str_of(b.get("type")) == Some("text"));
            return !blocks.is_empty() && narrated;
        }
        if !has_turn {
            return false;
        }
        let envelope = if results.len() == 1 {
            message.get("tool_use_result").filter(|e| !e.is_null())
        } else {
            None
        };
        for block in results {
            let id = str_of(block.get("tool_use_id")).unwrap_or("");
            let tool_name = str_of(block.get("tool_name"));
            let started = self.tools.remove(id);
            let base = started
                .clone()
                .unwrap_or_else(|| tools::generic_tool(tool_name.unwrap_or("unknown"), None));
            let failed = block.get("is_error") == Some(&Value::Bool(true));
            let content = block.get("content").unwrap_or(&Value::Null);
            let output = tools::tool_output(&base.shape, tool_name, content);
            let shape = tools::completed_shape(&base.shape, output.as_deref(), failed);
            let status = if failed { "failed" } else { "completed" };
            let key = ItemKey {
                provider_item_id: Some(id.to_owned()),
                channel: None,
                parent_ref: self.parent_ref.clone(),
            };
            let options =
                CloseOptions { presentation: Some(base.presentation), ..CloseOptions::new(status) };
            self.events.close_item(&key, shape, options);
            let call = started.map(|s| s.shape).filter(|s| tools::shape_type(s) == "toolCall");
            let tool = call.as_ref().and_then(|c| str_of(c.get("tool"))).or(tool_name);
            let Some(tool) = tool.filter(|_| !failed) else { continue };
            let output = output.map(Value::from);
            let reported = envelope.or(output.as_ref());
            let input = call.as_ref().and_then(|c| c.get("arguments"));
            if let Some(steps) = tools::fold_task_result(&mut self.plan, tool, input, reported) {
                self.plan_steps(&steps);
            }
        }
        true
    }

    fn result(&mut self, message: &Value) -> bool {
        let subtype = str_of(message.get("subtype"));
        let has_turn = self.active_turn();
        let origin =
            message.get("origin").filter(|o| o.is_object()).and_then(|o| str_of(o.get("kind")));
        let settles = (has_turn && self.turn.responded) || origin.unwrap_or("human") == "human";
        let (Some(subtype), true, true) = (subtype, has_turn, settles) else { return true };
        self.turn.responded = true;
        let reported = reported_context_window(message.get("modelUsage"));
        let window = reported.or(self.context_window);
        let used = self.turn.request_tokens;
        self.context_window = window;
        if used.is_some() || window.is_some() {
            self.report_context(used, window, true);
        }
        let usage = parse_usage(message.get("usage"));
        if usage.is_some() || reported.is_some() {
            let usage = usage.unwrap_or_default();
            let (input, output) = (tokens(usage.input), tokens(usage.output));
            let cached = tokens(usage.cache_read) + tokens(usage.cache_write);
            let last = TokenUsage {
                total_tokens: (input + output + cached) as u64,
                input_tokens: input as u64,
                cached_input_tokens: cached as u64,
                cache_read_input_tokens: usage.cache_read.map(|v| v as u64),
                cache_write_input_tokens: usage.cache_write.map(|v| v as u64),
                output_tokens: output as u64,
                reasoning_output_tokens: 0,
            };
            self.total = add_token_usage(&self.total, &last);
            let payload = json!({ "total": self.total, "last": last, "modelContextWindow": reported.map(num) });
            self.events.usage(payload, None);
        }
        let is_error = message.get("is_error") == Some(&Value::Bool(true));
        let failed = is_error || subtype.starts_with("error");
        if failed {
            let status = message.get("api_error_status").and_then(Value::as_f64);
            let listed = message.get("errors").and_then(Value::as_array).and_then(|errors| {
                errors.iter().map(|e| e.as_str().map(str::trim)).collect::<Option<Vec<_>>>()
            });
            let errors: Vec<&str> =
                listed.unwrap_or_default().into_iter().filter(|e| !e.is_empty()).collect();
            let stated = if is_error { str_of(message.get("result")) } else { None };
            let joined = errors.join("\n");
            let detail = match stated {
                Some(stated) => stated.to_owned(),
                None if !joined.is_empty() => joined,
                None => format!("Claude Code result failed: {subtype}"),
            };
            let mut report = json!({ "detail": detail });
            if let Some(info) = error_info(status, None, Some(subtype)) {
                report["errorInfo"] = info;
            }
            self.events.error(report, ErrorOptions::default());
        } else if self.has_blocking_tasks() {
            return true;
        }
        self.suppressed = failed;
        let status = if failed { "failed" } else { "completed" };
        self.events.close_turn(None, status, None, self.turn.checkpoint.as_deref());
        true
    }

    fn system(&mut self, message: &Value, subtype: &str) -> bool {
        let from = non_empty(str_of(message.get("original_model")));
        let to = non_empty(str_of(message.get("fallback_model")));
        let compaction = json!({ "type": "contextCompaction" });
        let key = ItemKey {
            provider_item_id: None,
            channel: Some("compaction".to_owned()),
            parent_ref: None,
        };
        let presentation = labels::compaction();
        if subtype == "api_retry"
            && let Some((attempt, max, delay, status, error)) = parse_retry(message)
        {
            let http = status.map(|s| format!(" HTTP {}", js_number(s))).unwrap_or_default();
            let detail = format!(
                "Claude Code API retry {}/{} after {}ms:{http} {error}",
                js_number(attempt),
                js_number(max),
                js_number(delay)
            );
            let thread_scoped = self.blocked();
            if !thread_scoped {
                self.ensure_turn();
            }
            let mut report = json!({ "detail": detail, "willRetry": true });
            if let Some(info) = error_info(status, Some(error), None) {
                report["errorInfo"] = info;
            }
            self.events.error(report, ErrorOptions { thread_scoped, ..ErrorOptions::default() });
            return true;
        }
        if subtype == "status" && str_of(message.get("status")) == Some("compacting") {
            if self.blocked() {
                return true;
            }
            self.ensure_turn().compacting = true;
            let options =
                ItemOptions { presentation: Some(presentation), ..ItemOptions::default() };
            self.events.open_item(&key, compaction, options);
        } else if subtype == "status" {
            let was_compacting = self.turn.compacting;
            let previous = self.turn.id.clone();
            self.turn.compacting = false;
            if !was_compacting || !self.active_turn() || self.turn.id != previous {
                return true;
            }
            let options =
                CloseOptions { presentation: Some(presentation), ..CloseOptions::new("completed") };
            self.events.close_item(&key, compaction, options);
        } else if subtype == "compact_boundary" {
            self.events.compacted(None);
            self.report_context(None, None, false);
        } else if let (true, Some(from), Some(to)) = (FALLBACK.is_match(subtype), from, to) {
            let fallback = format!("{from}\u{0}{to}");
            if self.turn.fallback.as_deref() == Some(fallback.as_str()) {
                return true;
            }
            self.turn.fallback = Some(fallback);
            let reason = if subtype == "model_refusal_fallback" { "refusal" } else { "provider" };
            let note = str_of(message.get("content"))
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Switched from {from} to {to}."));
            self.events.model_fallback(json!({
                "originalModel": from,
                "fallbackModel": to,
                "reason": reason,
                "message": note,
            }));
        } else {
            return self.task(message, subtype);
        }
        true
    }

    fn task_presentation(item: &Map<String, Value>) -> Presentation {
        let task_type = field(item, "taskType").unwrap_or("");
        let description = field(item, "description");
        if task_type == "local_workflow" {
            let title = field(item, "workflowName").or(description);
            return presentation("Running workflow", "Workflow finished", "Workflow", title);
        }
        let command = task_type == "local_bash";
        let noun = if command { "command" } else { "agent" };
        let glyph = if command { "Terminal" } else { "UserRound" };
        let pending = format!("Running background {noun}");
        let completed = format!("Background {noun} finished");
        presentation(&pending, &completed, glyph, description)
    }

    fn close_task(&mut self, id: &str, task_status: &str) {
        let Some(task) = self.tasks.get_mut(id) else { return };
        task.done = true;
        task.item.insert("taskStatus".to_owned(), Value::from(task_status));
        let presentation = Self::task_presentation(&task.item);
        let options = CloseOptions {
            presentation: Some(presentation),
            ..CloseOptions::new(item_status(task_status))
        };
        self.events.close_item(&task.key, Value::Object(task.item.clone()), options);
    }

    fn task(&mut self, message: &Value, subtype: &str) -> bool {
        let Some(id) = str_of(message.get("task_id")).map(str::to_owned) else { return false };
        let known = self.tasks.get(&id).cloned();
        let usage = parse_task_usage(message.get("usage"));
        let description = str_of(message.get("description"));
        if subtype == "task_started" {
            let task_type = str_of(message.get("task_type")).unwrap_or("unknown");
            let parent_ref = str_of(message.get("tool_use_id")).map(str::to_owned);
            let orphan = parent_ref.as_ref().is_some_and(|p| !self.tools.contains_key(p));
            let fresh = known.as_ref().map_or(!orphan, |k| k.done);
            let start = TASK_TYPES.contains(&task_type) && fresh && !self.blocked();
            let (true, Some(description)) = (start, description) else { return false };
            let generation = known.map_or(0, |k| k.generation) + 1;
            let suffix = if generation > 1 { format!("#{generation}") } else { String::new() };
            let key = ItemKey {
                provider_item_id: Some(format!("task:{id}{suffix}")),
                channel: None,
                parent_ref,
            };
            let mut item = json!({
                "type": "backgroundTask",
                "familyId": id,
                "taskType": task_type,
                "description": description,
                "taskStatus": "running",
                "skipTranscript": message.get("skip_transcript") == Some(&Value::Bool(true)),
            });
            if let Some(name) = str_of(message.get("workflow_name")) {
                item["workflowName"] = Value::from(name);
            }
            let Value::Object(item) = item else { return false };
            let presentation = Self::task_presentation(&item);
            self.tasks.insert(
                id.clone(),
                Task { key: key.clone(), generation, done: false, item: item.clone() },
            );
            self.ensure_turn();
            let options =
                ItemOptions { presentation: Some(presentation), ..ItemOptions::default() };
            self.events.open_item(&key, Value::Object(item), options);
            return true;
        }
        let Some(known) = known.filter(|k| !k.done) else { return false };
        let before = known.item.clone();
        let progress = |this: &mut Self, shape: Map<String, Value>| {
            let status = field(&shape, "taskStatus").unwrap_or("").to_owned();
            let flush = field(&shape, "taskStatus") != field(&before, "taskStatus");
            if let Some(task) = this.tasks.get_mut(&id) {
                task.item = shape.clone();
            }
            let snapshot = BackgroundSnapshot {
                shape: Value::Object(shape),
                status: item_status(&status).to_owned(),
            };
            let options =
                ProgressOptions { snapshot: Some(snapshot), flush, ..ProgressOptions::default() };
            this.events.progress(&known.key, options);
            true
        };
        let patch = message.get("patch").filter(|p| p.is_object());
        let patched = match patch.and_then(|p| p.get("status")) {
            None => Some(None),
            Some(Value::String(s))
                if matches!(
                    s.as_str(),
                    "pending" | "running" | "completed" | "failed" | "killed" | "paused"
                ) =>
            {
                Some(Some(s.clone()))
            }
            Some(_) => None,
        };
        let ended = str_of(message.get("status"))
            .filter(|s| matches!(*s, "completed" | "failed" | "stopped"));
        let (summary, file) = (str_of(message.get("summary")), str_of(message.get("output_file")));
        if let (true, Some(usage), true) =
            (subtype == "task_progress", &usage, description.is_some())
        {
            let mut shape = before.clone();
            shape.insert("usage".to_owned(), usage.clone());
            return progress(self, shape);
        }
        if let (true, Some(patch), Some(status)) = (subtype == "task_updated", patch, &patched) {
            let mut shape = before.clone();
            if let Some(status) = status {
                shape.insert("taskStatus".to_owned(), Value::from(status.as_str()));
            }
            if let Some(renamed) = str_of(patch.get("description")) {
                shape.insert("description".to_owned(), Value::from(renamed));
            }
            if let Some(error) = str_of(patch.get("error")) {
                shape.insert("error".to_owned(), Value::from(error));
            }
            return progress(self, shape);
        }
        let (true, Some(ended), Some(summary), Some(file)) =
            (subtype == "task_notification", ended, summary, file)
        else {
            return false;
        };
        let mut item = before;
        item.insert("summary".to_owned(), Value::from(summary));
        let usage = usage.or_else(|| item.get("usage").cloned());
        set_or_remove(&mut item, "usage", usage);
        if !file.is_empty() {
            item.insert("outputFile".to_owned(), Value::from(file));
        }
        if let Some(task) = self.tasks.get_mut(&id) {
            task.item = item;
        }
        self.close_task(&id, ended);
        true
    }
}

fn parse_retry(message: &Value) -> Option<(f64, f64, f64, Option<f64>, &str)> {
    let attempt = message.get("attempt")?.as_f64()?;
    let max = message.get("max_retries")?.as_f64()?;
    let delay = message.get("retry_delay_ms")?.as_f64()?;
    let status = match message.get("error_status")? {
        Value::Null => None,
        other => Some(other.as_f64()?),
    };
    Some((attempt, max, delay, status, message.get("error")?.as_str()?))
}

fn parse_task_usage(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let get = |key: &str| value.get(key).and_then(Value::as_f64).map(num);
    Some(json!({
        "totalTokens": get("total_tokens")?,
        "toolUses": get("tool_uses")?,
        "durationMs": get("duration_ms")?,
    }))
}
