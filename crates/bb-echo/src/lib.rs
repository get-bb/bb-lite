use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use bb_core::{
    AvailableModel, ExecutionOptions, ModelReasoningEffort, ProviderAuth, ProviderId,
    ProviderModels, ProviderStatus, ReasoningLevel, RunnerError, RunnerResult, SessionSpec,
    ToolCallOutputItem,
};
use bb_provider::{
    ApprovalEnforcer, CloseOptions, DeltaChannel, ErrorOptions, ExitInfo, Interaction, ItemKey,
    ItemOptions, Presentation, ProgressOptions, ProviderAdapter, ProviderSession, SessionHost,
    SteerInput, SteerOutcome, TextChannel, ToolCall, TurnInput, ZERO_TOKEN_USAGE, build_edit_diff,
    labels,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::watch;

const CONTEXT_WINDOW: u64 = 200_000;
const STATE_FILE: &str = "echo-state.json";

/// Finds `name` or `name:value` as a whitespace-separated word of `text` and returns the value
/// with `_` replaced by spaces (`""` for a bare `name`), like the TypeScript directive regex.
pub fn directive(text: &str, name: &str) -> Option<String> {
    text.split(is_js_space).find_map(|word| {
        let rest = word.strip_prefix(name)?;
        match rest.strip_prefix(':') {
            None if rest.is_empty() => Some(String::new()),
            Some(value) if !value.is_empty() => Some(value.replace('_', " ")),
            _ => None,
        }
    })
}

fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn js_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(is_js_space);
    if trimmed.is_empty() {
        return 0.0;
    }
    let radix = |prefix: [&str; 2], radix: u32| {
        let digits = prefix.iter().find_map(|p| trimmed.strip_prefix(p))?;
        Some(u128::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64))
    };
    if let Some(value) = radix(["0x", "0X"], 16)
        .or_else(|| radix(["0o", "0O"], 8))
        .or_else(|| radix(["0b", "0B"], 2))
    {
        return value;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let numeric =
        trimmed.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if !numeric {
        return f64::NAN;
    }
    trimmed.parse().unwrap_or(f64::NAN)
}

fn js_number_value(number: f64) -> Value {
    if !number.is_finite() {
        Value::Null
    } else if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        Value::from(number as i64)
    } else {
        Value::from(number)
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn reply_chunks(reply: &str, pieces: f64) -> Vec<String> {
    let units: Vec<u16> = reply.encode_utf16().collect();
    let len = units.len();
    let size = (len as f64 / pieces).ceil();
    if size.is_nan() {
        return if len > 0 { vec![String::new()] } else { Vec::new() };
    }
    let step = size.max(1.0);
    let step = if step < len as f64 { step as usize } else { len.max(1) };
    let mut chunks = Vec::new();
    let mut offset = 0;
    while offset < len {
        let mut end = (offset + step).min(len);
        if end < len && (0xd800..0xdc00).contains(&units[end - 1]) {
            end += 1;
        }
        chunks.push(String::from_utf16_lossy(&units[offset..end]));
        offset = end;
    }
    chunks
}

fn prompt_text(input: &[Value]) -> String {
    input
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

fn approval_payload(item_id: &str) -> Value {
    json!({
        "kind": "approval",
        "reason": null,
        "availableDecisions": ["allow_once", "deny"],
        "subject": {
            "kind": "command",
            "itemId": item_id,
            "command": "echo hi",
            "cwd": null,
            "actions": [],
            "sessionGrant": null,
        },
    })
}

fn question_payload(turn: &str) -> Value {
    let option = |label: &str, description: &str| json!({ "value": label.to_lowercase(), "label": label, "description": description });
    json!({
        "kind": "user_question",
        "questions": [{
            "id": format!("{turn}:question-1"),
            "prompt": "Which deployment path should the echo provider use?",
            "options": [
                option("Staging", "Deploy to staging first."),
                option("Production", "Deploy directly to production."),
            ],
            "shortLabel": "Path",
            "multiSelect": false,
            "allowFreeText": true,
        }],
    })
}

fn first_answer(resolution: &Value) -> (Vec<String>, String) {
    let parsed = (|| {
        let answers = resolution.get("answers")?.as_object()?;
        let mut parsed = Vec::with_capacity(answers.len());
        for answer in answers.values() {
            let answer = answer.as_object()?;
            let selected = match answer.get("selected") {
                None => Vec::new(),
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|item| item.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()?,
                Some(_) => return None,
            };
            let free_text = match answer.get("freeText") {
                None => String::new(),
                Some(Value::String(text)) => text.clone(),
                Some(_) => return None,
            };
            parsed.push((selected, free_text));
        }
        Some(parsed)
    })();
    parsed.and_then(|answers| answers.into_iter().next()).unwrap_or_default()
}

fn models() -> Vec<AvailableModel> {
    let efforts = [
        (ReasoningLevel::Low, "Low reasoning effort"),
        (ReasoningLevel::Medium, "Medium reasoning effort"),
        (ReasoningLevel::High, "High reasoning effort"),
    ]
    .map(|(reasoning_effort, description)| ModelReasoningEffort {
        reasoning_effort,
        description: description.to_owned(),
    });
    ["echo-1", "echo-2"]
        .iter()
        .enumerate()
        .map(|(index, id)| AvailableModel {
            id: (*id).to_owned(),
            model: (*id).to_owned(),
            display_name: if index == 0 { "Echo" } else { "Echo Two" }.to_owned(),
            route_provider_id: None,
            description: "Scripted provider for development and tests".to_owned(),
            supported_reasoning_efforts: efforts.to_vec(),
            default_reasoning_effort: ReasoningLevel::Medium,
            is_default: index == 0,
        })
        .collect()
}

struct Turn {
    key: String,
    bb_id: String,
    text: String,
    cancelled: AtomicBool,
}

impl Turn {
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

struct Item {
    key: ItemKey,
    id: String,
    turn: String,
    presentation: Presentation,
}

struct Session {
    provider_thread_id: String,
    turns: Mutex<u64>,
    spec: SessionSpec,
    host: SessionHost,
    active: Mutex<Option<Arc<Turn>>>,
    closed: watch::Sender<bool>,
}

struct EchoSession(Arc<Session>);

impl Session {
    fn state_path(&self) -> std::path::PathBuf {
        Path::new(&self.host.thread_storage_dir).join(STATE_FILE)
    }

    fn item(&self, turn: &str, name: &str, shape: Value, presentation: Presentation) -> Item {
        let key = ItemKey::provider(format!("{turn}-{name}"));
        let options =
            ItemOptions { turn: Some(turn.to_owned()), presentation: Some(presentation.clone()) };
        let id = self.host.events.open_item(&key, shape, options);
        let id = id.unwrap_or_else(|| format!("{turn}-{name}"));
        Item { key, id, turn: turn.to_owned(), presentation }
    }

    fn close_item(&self, item: &Item, shape: Value) {
        let options = CloseOptions {
            turn: Some(item.turn.clone()),
            presentation: Some(item.presentation.clone()),
            ..CloseOptions::new("completed")
        };
        self.host.events.close_item(&item.key, shape, options);
    }

    fn say(&self, turn: &str, id: &str, text: &str, parent_ref: Option<&str>) {
        let key = ItemKey::provider(id).with_parent_ref(parent_ref);
        let presentation = Some(labels::message());
        let options =
            ItemOptions { turn: Some(turn.to_owned()), presentation: presentation.clone() };
        let events = &self.host.events;
        events.open_item(&key, json!({ "type": "agentMessage", "text": "" }), options);
        let close = CloseOptions {
            turn: Some(turn.to_owned()),
            presentation,
            ..CloseOptions::new("completed")
        };
        events.close_item(&key, json!({ "type": "agentMessage", "text": text }), close);
    }

    fn finish(&self, turn: &Arc<Turn>, status: &str) {
        turn.cancelled.store(true, Ordering::SeqCst);
        {
            let mut active = self.active.lock();
            if active.as_ref().is_some_and(|live| Arc::ptr_eq(live, turn)) {
                *active = None;
            }
        }
        self.host.events.close_turn(Some(&turn.key), status, None, Some(&turn.key));
    }

    fn fail(&self, turn: &str, detail: &str) {
        {
            let mut active = self.active.lock();
            if active.as_ref().map(|live| live.key.as_str()) != Some(turn) {
                return;
            }
            *active = None;
        }
        let report = json!({ "detail": detail, "willRetry": false });
        let options =
            ErrorOptions { turn: Some(turn.to_owned()), settles_turn: true, thread_scoped: false };
        self.host.events.error(report, options);
    }

    async fn wait(&self, turn: &Turn, ms: f64) -> bool {
        if ms <= 0.0 {
            return !turn.cancelled();
        }
        let ms = if ms.is_nan() || ms > 2_147_483_647.0 { 1.0 } else { ms.max(1.0) };
        let mut closed = self.closed.subscribe();
        tokio::select! {
            () = tokio::time::sleep(Duration::from_secs_f64(ms / 1000.0)) => !turn.cancelled(),
            _ = closed.wait_for(|closed| *closed) => false,
        }
    }

    async fn interact(&self, live: &Turn) -> Result<Option<String>, String> {
        let host = &self.host;
        let (turn, turn_id, text) = (&live.key, &live.bb_id, &live.text);
        let host_error = |error: RunnerError| format!("RunnerError: {error}");
        if directive(text, "approve").is_some() {
            let payload = approval_payload(&format!("approval-{turn}"));
            let interaction = Interaction { payload, turn_id: Some(turn_id.clone()) };
            let resolution = host.request_interaction(interaction).await.map_err(host_error)?;
            let decision = resolution.as_object().and_then(|object| object.get("decision"));
            if decision.is_none_or(|decision| decision == "deny") {
                return Ok(Some("Denied".to_owned()));
            }
        }
        if directive(text, "ask_user").is_some() {
            let payload = question_payload(turn);
            let interaction = Interaction { payload, turn_id: Some(turn_id.clone()) };
            let resolution = host.request_interaction(interaction).await.map_err(host_error)?;
            let (mut parts, free_text) = first_answer(&resolution);
            parts.push(free_text);
            let given =
                parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(", ");
            let given = if given.is_empty() { "no answer".to_owned() } else { given };
            return Ok(Some(format!("Question answered: {given}")));
        }
        let Some(tool) = directive(text, "call_tool") else { return Ok(None) };
        let encoded = directive(text, "tool_input").unwrap_or_else(|| "{}".to_owned());
        let input: Value =
            serde_json::from_str(&encoded).map_err(|error| format!("SyntaxError: {error}"))?;
        if !input.is_object() {
            return Err(format!("ZodError: expected object, received {}", json_kind(&input)));
        }
        let call = json!({ "type": "toolCall", "server": "bb", "tool": tool, "arguments": input });
        let item = self.item(turn, "call", call.clone(), labels::tool(&tool, None));
        let request = ToolCall {
            call_id: item.id.clone(),
            tool: tool.clone(),
            arguments: input,
            turn_id: Some(turn_id.clone()),
        };
        let response = host.call_tool(request).await.map_err(host_error)?;
        let texts: Vec<&str> = response
            .content_items
            .iter()
            .filter_map(|content| match content {
                ToolCallOutputItem::InputText { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let mut closed = call;
        closed["result"] = Value::from(texts.join("\n"));
        self.close_item(&item, closed);
        Ok(Some(format!("Tool called: {tool}")))
    }

    async fn run(&self, live: &Arc<Turn>) -> Result<(), String> {
        let events = &self.host.events;
        let (turn, text) = (live.key.as_str(), live.text.as_str());
        let pace = js_number(&directive(text, "pace").unwrap_or_else(|| "0".to_owned()));
        if let Some(thought) = directive(text, "think") {
            let empty = json!({ "type": "reasoning", "summary": [], "content": [] });
            let item = self.item(turn, "think", empty.clone(), labels::reasoning());
            let channel = DeltaChannel::Text(TextChannel::ReasoningText);
            events.delta(&item.key, channel, &thought, Some(turn));
            let mut closed = empty;
            closed["content"] = json!([thought]);
            self.close_item(&item, closed);
        }
        if let Some(command) = directive(text, "cmd") {
            let shape =
                json!({ "type": "commandExecution", "command": command, "cwd": self.spec.cwd });
            let item = self.item(turn, "cmd", shape.clone(), labels::command(&command));
            let output = [format!("$ {command}\n"), "ok\n".to_owned()];
            for chunk in &output {
                events.delta(&item.key, DeltaChannel::Command, chunk, Some(turn));
                if !self.wait(live, pace).await {
                    return Ok(());
                }
            }
            let mut closed = shape;
            closed["aggregatedOutput"] = Value::from(output.concat());
            closed["exitCode"] = Value::from(0);
            closed["durationMs"] = Value::from(1);
            self.close_item(&item, closed);
        }
        if let Some(path) = directive(text, "edit") {
            let diff = build_edit_diff(&path, Some("before\n"), Some("after\n"));
            let mut change = json!({ "path": path, "kind": "update" });
            if let Some(diff) = diff {
                change["diff"] = Value::from(diff);
            }
            let shape = json!({ "type": "fileChange", "changes": [change] });
            let item = self.item(turn, "edit", shape.clone(), labels::file_change(&[&path]));
            self.close_item(&item, shape);
        }
        if let Some(tool) = directive(text, "tool") {
            let shape =
                json!({ "type": "toolCall", "server": "echo", "tool": tool, "arguments": {} });
            let item = self.item(turn, "tool", shape.clone(), labels::tool(&tool, Some("echo")));
            let progress = ProgressOptions {
                turn: Some(turn.to_owned()),
                message: Some("working".to_owned()),
                flush: true,
                snapshot: None,
            };
            events.progress(&item.key, progress);
            let mut closed = shape;
            closed["result"] = Value::from("ok");
            closed["durationMs"] = Value::from(1);
            self.close_item(&item, closed);
        }
        if let Some(label) = directive(text, "subagent") {
            let child_turn = format!("{turn}-child");
            let shape = json!({
                "type": "delegation",
                "label": label,
                "childRef": child_turn,
                "background": false,
            });
            let item = self.item(turn, "agent", shape.clone(), labels::agent(&label));
            let parent_ref = item.key.provider_item_id.clone().unwrap_or_default();
            events.open_turn(Some(&child_turn), Some(&parent_ref));
            let summary = format!("Subagent {label} finished");
            self.say(&child_turn, &format!("{turn}-agent-reply"), &summary, Some(&parent_ref));
            events.close_turn(Some(&child_turn), "completed", None, None);
            let mut closed = shape;
            closed["summary"] = Value::from(summary);
            self.close_item(&item, closed);
        }
        let outcome = self.interact(live).await?;
        if live.cancelled() {
            return Ok(());
        }
        if directive(text, "crash").is_some() {
            *self.active.lock() = None;
            let message = "echo provider exited (code 1)".to_owned();
            self.host.on_exit(ExitInfo { message, stderr_tail: "scripted crash".to_owned() });
            return Ok(());
        }
        if let Some(failure) = directive(text, "fail_turn") {
            self.fail(turn, &failure);
            return Ok(());
        }
        if directive(text, "hold_turn").is_some() {
            return Ok(());
        }
        let delay = js_number(&directive(text, "delay").unwrap_or_else(|| "0".to_owned()));
        if !self.wait(live, delay).await {
            return Ok(());
        }
        let reply = match outcome {
            Some(outcome) => outcome,
            None if directive(text, "count").is_some() => {
                format!("Turn count: {}", *self.turns.lock())
            }
            None if !text.is_empty() => format!("Response to: {text}"),
            None => "Response complete".to_owned(),
        };
        let pieces = js_number(&directive(text, "stream").unwrap_or_else(|| "1".to_owned()));
        let empty = json!({ "type": "agentMessage", "text": "" });
        let item = self.item(turn, "reply", empty, labels::message());
        for delta in reply_chunks(&reply, pieces) {
            let channel = DeltaChannel::Text(TextChannel::AgentMessage);
            events.delta(&item.key, channel, &delta, Some(turn));
            if !self.wait(live, pace).await {
                return Ok(());
            }
        }
        self.close_item(&item, json!({ "type": "agentMessage", "text": reply }));
        let tokens = match directive(text, "usage") {
            Some(usage) => js_number(&usage),
            None => (100 + utf16_len(text)) as f64,
        };
        let turns = *self.turns.lock() as f64;
        let mut last = serde_json::to_value(ZERO_TOKEN_USAGE).unwrap_or_else(|_| json!({}));
        last["totalTokens"] = js_number_value(tokens);
        last["inputTokens"] = js_number_value(tokens);
        let mut total = last.clone();
        total["totalTokens"] = js_number_value(tokens * turns);
        let usage = json!({ "total": total, "last": last, "modelContextWindow": CONTEXT_WINDOW });
        events.usage(usage, Some(turn));
        let window = json!({
            "usedTokens": js_number_value(tokens),
            "modelContextWindow": CONTEXT_WINDOW,
            "estimated": false,
        });
        events.context_window(window, Some(turn), false);
        self.finish(live, "completed");
        Ok(())
    }
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[async_trait]
impl ProviderSession for EchoSession {
    fn provider_thread_id(&self) -> String {
        self.0.provider_thread_id.clone()
    }

    fn can_apply(&self, spec: &SessionSpec, _options: &ExecutionOptions) -> bool {
        spec.cwd == self.0.spec.cwd
    }

    async fn start_turn(&self, args: TurnInput) -> RunnerResult<()> {
        let session = &self.0;
        let text = prompt_text(&args.input);
        let turns = {
            let mut turns = session.turns.lock();
            *turns += 1;
            *turns
        };
        let state = json!({ "providerThreadId": session.provider_thread_id, "turns": turns });
        tokio::fs::write(session.state_path(), state.to_string()).await?;
        if directive(&text, "swallow_turn").is_some() {
            return Ok(());
        }
        let events = &session.host.events;
        events.accept_input(&args.client_request_id, None);
        let key = format!("turn-{turns}");
        let bb_id = events.open_turn(Some(&key), None);
        let live = Arc::new(Turn { key, bb_id, text, cancelled: AtomicBool::new(false) });
        *session.active.lock() = Some(live.clone());
        let session = session.clone();
        tokio::spawn(async move {
            if let Err(error) = session.run(&live).await {
                session.fail(&live.key, &format!("request failed: {error}"));
            }
        });
        tokio::task::yield_now().await;
        Ok(())
    }

    async fn steer(&self, args: SteerInput) -> RunnerResult<SteerOutcome> {
        let session = &self.0;
        let turn = session.active.lock().clone();
        let Some(turn) = turn.filter(|turn| turn.bb_id == args.expected_turn_id) else {
            return Ok(SteerOutcome::Stale);
        };
        let text = prompt_text(&args.input);
        session.host.events.accept_input(&args.client_request_id, Some(&turn.key));
        let id = format!("steer-{}", args.client_request_id);
        session.say(&turn.key, &id, &format!("Steered: {text}"), None);
        if directive(&text, "release_turn").is_some() {
            session.finish(&turn, "completed");
        }
        Ok(SteerOutcome::Steered)
    }

    async fn interrupt(&self) -> RunnerResult<()> {
        let turn = self.0.active.lock().clone();
        if let Some(turn) = turn
            && directive(&turn.text, "ignore_interrupt").is_none()
        {
            self.0.finish(&turn, "interrupted");
        }
        Ok(())
    }

    async fn close(&self) -> RunnerResult<()> {
        if let Some(turn) = self.0.active.lock().take() {
            turn.cancelled.store(true, Ordering::SeqCst);
        }
        self.0.closed.send_replace(true);
        Ok(())
    }

    fn supports_rename(&self) -> bool {
        true
    }

    async fn rename(&self, title: &str) -> RunnerResult<()> {
        self.0.host.events.name(title);
        Ok(())
    }
}

struct EchoAdapter;

#[async_trait]
impl ProviderAdapter for EchoAdapter {
    fn id(&self) -> ProviderId {
        ProviderId::Echo
    }

    fn approval_enforced_by(&self) -> ApprovalEnforcer {
        ApprovalEnforcer::Runner
    }

    async fn status(&self) -> RunnerResult<ProviderStatus> {
        Ok(ProviderStatus {
            provider_id: ProviderId::Echo,
            installed: true,
            executable_path: None,
            version: Some("1.0.0".to_owned()),
            auth: ProviderAuth::Ready,
            message: None,
        })
    }

    async fn list_models(&self, _cwd: Option<&str>) -> RunnerResult<ProviderModels> {
        Ok(ProviderModels { models: models(), selected_only_models: Vec::new() })
    }

    async fn open(
        &self,
        spec: SessionSpec,
        _options: ExecutionOptions,
        host: SessionHost,
    ) -> RunnerResult<Arc<dyn ProviderSession>> {
        let provider_thread_id =
            spec.provider_thread_id.clone().unwrap_or_else(|| format!("echo-{}", spec.thread_id));
        let path = Path::new(&host.thread_storage_dir).join(STATE_FILE);
        let stored = tokio::fs::read_to_string(&path).await.unwrap_or_else(|_| "{}".to_owned());
        let state: Value = serde_json::from_str(&stored)
            .map_err(|error| RunnerError::failed(format!("SyntaxError: {error}")))?;
        let stored_turns = (|| {
            let object: &Map<String, Value> = state.as_object()?;
            let id = object.get("providerThreadId")?.as_str()?;
            let turns = object.get("turns")?.as_u64()?;
            (id == provider_thread_id).then_some(turns)
        })();
        host.events.identity(&provider_thread_id);
        if spec.provider_thread_id.is_none() {
            host.events.started();
        }
        let (closed, _) = watch::channel(false);
        Ok(Arc::new(EchoSession(Arc::new(Session {
            provider_thread_id,
            turns: Mutex::new(stored_turns.unwrap_or(0)),
            spec,
            host,
            active: Mutex::new(None),
            closed,
        }))))
    }
}

pub fn create_echo_adapter() -> Arc<dyn ProviderAdapter> {
    Arc::new(EchoAdapter)
}
