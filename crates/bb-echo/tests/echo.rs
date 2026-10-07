use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bb_core::{
    ExecutionOptions, PermissionEscalation, PermissionMode, ProviderAuth, ProviderId,
    ReasoningLevel, RunnerError, RunnerResult, ServiceTier, SessionSpec, ToolCallResponse,
};
use bb_echo::{create_echo_adapter, directive};
use bb_provider::{
    EventBuilder, EventBuilderOptions, ExitInfo, Interaction, ProviderSession, SessionHost,
    SessionHostCallbacks, SteerInput, SteerOutcome, ToolCall, TurnInput,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

#[derive(Default)]
struct Script {
    events: Mutex<Vec<Value>>,
    resolutions: Mutex<VecDeque<RunnerResult<Value>>>,
    interactions: Mutex<Vec<Interaction>>,
    tool_calls: Mutex<Vec<ToolCall>>,
    exits: Mutex<Vec<ExitInfo>>,
}

struct Callbacks(Arc<Script>);

#[async_trait]
impl SessionHostCallbacks for Callbacks {
    async fn call_tool(&self, call: ToolCall) -> RunnerResult<ToolCallResponse> {
        let reply = format!("host saw {}", call.arguments);
        self.0.tool_calls.lock().push(call);
        tokio::time::sleep(Duration::from_millis(10)).await;
        Ok(ToolCallResponse::text(reply, true))
    }

    async fn request_interaction(&self, interaction: Interaction) -> RunnerResult<Value> {
        self.0.interactions.lock().push(interaction);
        tokio::time::sleep(Duration::from_millis(10)).await;
        let next = self.0.resolutions.lock().pop_front();
        next.unwrap_or_else(|| Ok(json!({})))
    }

    fn on_exit(&self, info: ExitInfo) {
        self.0.exits.lock().push(info);
    }
}

struct Harness {
    script: Arc<Script>,
    session: Arc<dyn ProviderSession>,
    _dir: tempfile::TempDir,
}

fn options() -> ExecutionOptions {
    ExecutionOptions {
        model: "echo-1".to_owned(),
        reasoning_level: ReasoningLevel::Medium,
        service_tier: ServiceTier::Default,
        permission_mode: PermissionMode::Auto,
        permission_escalation: PermissionEscalation::Ask,
        provider_options: Default::default(),
    }
}

fn spec(cwd: &str, provider_thread_id: Option<&str>) -> SessionSpec {
    SessionSpec {
        thread_id: "thr_1".to_owned(),
        provider_id: ProviderId::Echo,
        cwd: cwd.to_owned(),
        provider_thread_id: provider_thread_id.map(str::to_owned),
        instructions: String::new(),
        dynamic_tools: Vec::new(),
        env: Default::default(),
        skill_dirs: Vec::new(),
    }
}

async fn open_in(dir: tempfile::TempDir, provider_thread_id: Option<&str>) -> Harness {
    let script = Arc::new(Script::default());
    let sink = script.clone();
    let mut builder =
        EventBuilderOptions::new(Arc::new(move |event| sink.events.lock().push(event)));
    builder.text_flush_ms = 0;
    builder.progress_throttle_ms = 0;
    let host = SessionHost {
        events: Arc::new(EventBuilder::with_options(builder)),
        env: Default::default(),
        process_env: Default::default(),
        thread_storage_dir: dir.path().to_string_lossy().into_owned(),
        writable_roots: Vec::new(),
        callbacks: Arc::new(Callbacks(script.clone())),
    };
    let adapter = create_echo_adapter();
    let session = adapter.open(spec("/work", provider_thread_id), options(), host).await.unwrap();
    Harness { script, session, _dir: dir }
}

async fn open() -> Harness {
    open_in(tempfile::tempdir().unwrap(), None).await
}

fn text_input(text: &str) -> Vec<Value> {
    vec![json!({ "type": "text", "text": text })]
}

impl Harness {
    async fn start(&self, text: &str) {
        let input = TurnInput {
            client_request_id: "req-1".to_owned(),
            input: text_input(text),
            options: options(),
        };
        self.session.start_turn(input).await.unwrap();
    }

    async fn settle(&self) {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }

    fn events(&self) -> Vec<Value> {
        self.script.events.lock().clone()
    }

    fn types(&self) -> Vec<String> {
        self.events().iter().map(|e| e["type"].as_str().unwrap_or("").to_owned()).collect()
    }

    fn of_type(&self, kind: &str) -> Vec<Value> {
        self.events().into_iter().filter(|e| e["type"] == kind).collect()
    }

    fn completed_items(&self) -> Vec<Value> {
        self.of_type("item/completed").into_iter().map(|e| e["item"].clone()).collect()
    }

    fn reply(&self) -> String {
        let items = self.completed_items();
        let reply = items.iter().rev().find(|item| item["type"] == "agentMessage").unwrap();
        reply["text"].as_str().unwrap().to_owned()
    }

    fn turn_status(&self) -> Option<String> {
        self.of_type("turn/completed").last().map(|e| e["status"].as_str().unwrap_or("").to_owned())
    }

    async fn steer(&self, id: &str, text: &str, expected_turn_id: &str) -> SteerOutcome {
        let input = SteerInput {
            client_request_id: id.to_owned(),
            input: text_input(text),
            options: options(),
            expected_turn_id: expected_turn_id.to_owned(),
        };
        self.session.steer(input).await.unwrap()
    }

    fn resolve(&self, resolution: RunnerResult<Value>) {
        self.script.resolutions.lock().push_back(resolution);
    }

    fn errors(&self) -> Vec<String> {
        let errors = self.of_type("provider/error");
        errors.iter().map(|e| e["detail"].as_str().unwrap_or("").to_owned()).collect()
    }

    fn active_turn_id(&self) -> String {
        self.of_type("turn/started").last().unwrap()["scope"]["turnId"].as_str().unwrap().to_owned()
    }
}

#[test]
fn directives_match_whole_words() {
    assert_eq!(directive("a tool:x_y b", "tool").as_deref(), Some("x y"));
    assert_eq!(directive("tool", "tool").as_deref(), Some(""));
    assert_eq!(directive("x\ttool\ny", "tool").as_deref(), Some(""));
    assert_eq!(directive("tools tool: xtool:a", "tool"), None);
    assert_eq!(directive("tool:one tool:two", "tool").as_deref(), Some("one"));
    assert_eq!(directive("call_tool:x", "tool"), None);
}

#[tokio::test(start_paused = true)]
async fn plain_turn() {
    let h = open().await;
    h.start("hello").await;
    h.settle().await;
    let expected = [
        "thread/identity",
        "thread/started",
        "turn/started",
        "turn/input/accepted",
        "item/started",
        "item/agentMessage/delta",
        "item/completed",
        "thread/tokenUsage/updated",
        "thread/contextWindowUsage/updated",
        "turn/completed",
    ];
    assert_eq!(h.types(), expected);
    assert_eq!(h.reply(), "Response to: hello");
    let done = h.of_type("turn/completed").pop().unwrap();
    assert_eq!(done["status"], "completed");
    assert_eq!(done["providerCheckpointId"], "turn-1");
    let usage = &h.of_type("thread/tokenUsage/updated")[0]["tokenUsage"];
    assert_eq!(usage["last"]["totalTokens"], 105);
    assert_eq!(usage["total"]["inputTokens"], 105);
    assert_eq!(usage["modelContextWindow"], 200_000);
    let window = &h.of_type("thread/contextWindowUsage/updated")[0]["contextWindowUsage"];
    assert_eq!(
        *window,
        json!({ "usedTokens": 105, "modelContextWindow": 200000, "estimated": false })
    );
    let state = std::fs::read_to_string(h._dir.path().join("echo-state.json")).unwrap();
    assert_eq!(state, r#"{"providerThreadId":"echo-thr_1","turns":1}"#);
    assert_eq!(h.session.provider_thread_id(), "echo-thr_1");
}

#[tokio::test(start_paused = true)]
async fn undelayed_turn_completes_before_start_returns() {
    let h = open().await;
    h.start("").await;
    assert_eq!(h.reply(), "Response complete");
    assert_eq!(h.turn_status().as_deref(), Some("completed"));
}

#[tokio::test(start_paused = true)]
async fn item_directives() {
    let h = open().await;
    h.start("think:plan_it cmd:ls edit:src/a.txt tool:grep subagent:scout").await;
    h.settle().await;
    let items = h.completed_items();
    let kinds: Vec<&str> = items.iter().map(|i| i["type"].as_str().unwrap()).collect();
    let expected = [
        "reasoning",
        "commandExecution",
        "fileChange",
        "toolCall",
        "agentMessage",
        "delegation",
        "agentMessage",
    ];
    assert_eq!(kinds, expected);
    assert_eq!(items[0]["content"], json!(["plan it"]));
    assert_eq!(items[1]["aggregatedOutput"], "$ ls\nok\n");
    assert_eq!(items[1]["cwd"], "/work");
    assert_eq!(items[1]["exitCode"], 0);
    assert_eq!(
        items[2]["changes"][0]["diff"],
        "--- a/src/a.txt\n+++ b/src/a.txt\n-before\n+after\n"
    );
    assert_eq!(items[2]["presentation"]["title"], "a.txt");
    assert_eq!(items[3]["server"], "echo");
    assert_eq!(items[3]["result"], "ok");
    assert_eq!(items[3]["presentation"]["label"]["completed"], "Ran grep");
    assert_eq!(items[4]["text"], "Subagent scout finished");
    assert_eq!(items[4]["parentToolCallId"], items[5]["id"]);
    assert_eq!(items[5]["summary"], "Subagent scout finished");
    assert_eq!(items[5]["childRef"], "turn-1-child");
    assert_eq!(h.of_type("item/reasoning/textDelta")[0]["delta"], "plan it");
    assert_eq!(h.of_type("item/commandExecution/outputDelta").len(), 2);
    assert_eq!(h.of_type("item/toolCall/progress")[0]["message"], "working");
    assert_eq!(h.of_type("turn/started").len(), 2);
    assert_eq!(h.of_type("turn/completed").len(), 2);
}

#[tokio::test(start_paused = true)]
async fn stream_and_pace() {
    let h = open().await;
    h.start("stream:3 pace:100").await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(h.of_type("item/agentMessage/delta").len(), 2);
    assert_eq!(h.turn_status(), None);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let deltas: Vec<String> = h
        .of_type("item/agentMessage/delta")
        .iter()
        .map(|e| e["delta"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(deltas, ["Response t", "o: stream:", "3 pace:100"]);
    assert_eq!(h.turn_status().as_deref(), Some("completed"));
}

#[tokio::test(start_paused = true)]
async fn count_and_usage_accumulate_and_resume() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let h = open_in(dir, None).await;
    h.start("count usage:42").await;
    h.settle().await;
    h.start("count usage:42").await;
    h.settle().await;
    assert_eq!(h.reply(), "Turn count: 2");
    let usage = &h.of_type("thread/tokenUsage/updated")[1]["tokenUsage"];
    assert_eq!(usage["last"]["totalTokens"], 42);
    assert_eq!(usage["total"]["totalTokens"], 84);
    let copy = tempfile::tempdir().unwrap();
    std::fs::copy(path.join("echo-state.json"), copy.path().join("echo-state.json")).unwrap();
    let resumed = open_in(copy, Some("echo-thr_1")).await;
    assert!(!resumed.types().contains(&"thread/started".to_owned()));
    resumed.start("count").await;
    resumed.settle().await;
    assert_eq!(resumed.reply(), "Turn count: 3");
    let other = tempfile::tempdir().unwrap();
    std::fs::copy(path.join("echo-state.json"), other.path().join("echo-state.json")).unwrap();
    let fresh = open_in(other, Some("echo-other")).await;
    fresh.start("count").await;
    fresh.settle().await;
    assert_eq!(fresh.reply(), "Turn count: 1");
}

#[tokio::test(start_paused = true)]
async fn steer_into_delayed_turn() {
    let h = open().await;
    h.start("delay:5000").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let turn_id = h.active_turn_id();
    assert_eq!(h.steer("req-2", "more", "wrong").await, SteerOutcome::Stale);
    assert_eq!(h.steer("req-2", "more", &turn_id).await, SteerOutcome::Steered);
    assert_eq!(h.reply(), "Steered: more");
    let accepted = h.of_type("turn/input/accepted");
    assert_eq!(accepted[1]["clientRequestId"], "req-2");
    assert_eq!(accepted[1]["scope"]["turnId"], turn_id.as_str());
    assert_eq!(h.turn_status(), None);
    h.settle().await;
    assert_eq!(h.reply(), "Response to: delay:5000");
    assert_eq!(h.turn_status().as_deref(), Some("completed"));
    assert_eq!(h.steer("req-3", "late", &turn_id).await, SteerOutcome::Stale);
}

#[tokio::test(start_paused = true)]
async fn steer_release_turn_finishes_held_turn() {
    let h = open().await;
    h.start("hold_turn").await;
    h.settle().await;
    assert_eq!(h.turn_status(), None);
    let turn_id = h.active_turn_id();
    assert_eq!(h.steer("req-2", "release_turn", &turn_id).await, SteerOutcome::Steered);
    assert_eq!(h.turn_status().as_deref(), Some("completed"));
    assert_eq!(h.reply(), "Steered: release_turn");
}

#[tokio::test(start_paused = true)]
async fn interrupt_stops_the_turn() {
    let h = open().await;
    h.start("delay:5000").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.session.interrupt().await.unwrap();
    let done = h.of_type("turn/completed").pop().unwrap();
    assert_eq!(done["status"], "interrupted");
    assert_eq!(done["providerCheckpointId"], "turn-1");
    let count = h.events().len();
    h.settle().await;
    assert_eq!(h.events().len(), count);
}

#[tokio::test(start_paused = true)]
async fn ignore_interrupt_keeps_the_turn() {
    let h = open().await;
    h.start("hold_turn ignore_interrupt").await;
    h.settle().await;
    h.session.interrupt().await.unwrap();
    assert_eq!(h.turn_status(), None);
    let turn_id = h.active_turn_id();
    assert_eq!(h.steer("req-2", "x", &turn_id).await, SteerOutcome::Steered);
}

#[tokio::test(start_paused = true)]
async fn close_cancels_pending_waits() {
    let h = open().await;
    h.start("delay:5000").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let count = h.events().len();
    h.session.close().await.unwrap();
    h.settle().await;
    assert_eq!(h.events().len(), count);
}

#[tokio::test(start_paused = true)]
async fn swallow_turn_emits_nothing() {
    let h = open().await;
    h.start("swallow_turn").await;
    h.settle().await;
    assert_eq!(h.types(), ["thread/identity", "thread/started"]);
    let state = std::fs::read_to_string(h._dir.path().join("echo-state.json")).unwrap();
    assert!(state.contains(r#""turns":1"#));
}

#[tokio::test(start_paused = true)]
async fn fail_turn_reports_error() {
    let h = open().await;
    h.start("fail_turn:boom_now").await;
    h.settle().await;
    assert_eq!(h.errors(), ["boom now"]);
    let error = h.of_type("provider/error").pop().unwrap();
    assert_eq!(error["willRetry"], false);
    assert_eq!(h.turn_status().as_deref(), Some("failed"));
}

#[tokio::test(start_paused = true)]
async fn crash_calls_on_exit() {
    let h = open().await;
    h.start("crash").await;
    h.settle().await;
    let exits = h.script.exits.lock().clone();
    let expected = ExitInfo {
        message: "echo provider exited (code 1)".to_owned(),
        stderr_tail: "scripted crash".to_owned(),
    };
    assert_eq!(exits, [expected]);
    assert_eq!(h.turn_status(), None);
    let turn_id = h.active_turn_id();
    assert_eq!(h.steer("req-2", "x", &turn_id).await, SteerOutcome::Stale);
}

#[tokio::test(start_paused = true)]
async fn dynamic_tool_call_answered_by_host() {
    let h = open().await;
    h.start(r#"call_tool:lookup tool_input:{"q":1}"#).await;
    h.settle().await;
    let calls = h.script.tool_calls.lock().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].tool, "lookup");
    assert_eq!(calls[0].arguments, json!({ "q": 1 }));
    assert_eq!(calls[0].turn_id.as_deref(), Some(h.active_turn_id().as_str()));
    let items = h.completed_items();
    assert_eq!(items[0]["type"], "toolCall");
    assert_eq!(items[0]["server"], "bb");
    assert_eq!(items[0]["id"].as_str(), Some(calls[0].call_id.as_str()));
    assert_eq!(items[0]["result"], r#"host saw {"q":1}"#);
    assert_eq!(items[0]["presentation"]["label"]["pending"], "Running lookup");
    assert_eq!(h.reply(), "Tool called: lookup");
}

#[tokio::test(start_paused = true)]
async fn bad_tool_input_fails_the_turn() {
    let h = open().await;
    h.start("call_tool:lookup tool_input:nope").await;
    h.settle().await;
    assert!(h.errors()[0].starts_with("request failed: SyntaxError: "));
    assert_eq!(h.turn_status().as_deref(), Some("failed"));
}

#[tokio::test(start_paused = true)]
async fn approval_allowed_and_denied() {
    let h = open().await;
    h.resolve(Ok(json!({ "decision": "allow_once" })));
    h.start("approve").await;
    h.settle().await;
    assert_eq!(h.reply(), "Response to: approve");
    let payload = h.script.interactions.lock()[0].payload.clone();
    assert_eq!(payload["kind"], "approval");
    assert_eq!(payload["availableDecisions"], json!(["allow_once", "deny"]));
    assert_eq!(payload["subject"]["itemId"], "approval-turn-1");
    assert_eq!(payload["subject"]["command"], "echo hi");
    h.resolve(Ok(json!({ "decision": "deny" })));
    h.start("approve").await;
    h.settle().await;
    assert_eq!(h.reply(), "Denied");
    h.resolve(Ok(json!({ "cancelled": true })));
    h.start("approve ask_user").await;
    h.settle().await;
    assert_eq!(h.reply(), "Denied");
    assert_eq!(h.script.interactions.lock().len(), 3);
}

#[tokio::test(start_paused = true)]
async fn question_answered() {
    let h = open().await;
    h.resolve(Ok(json!({ "answers": { "q": { "selected": ["staging"], "freeText": "soon" } } })));
    h.start("ask_user").await;
    h.settle().await;
    assert_eq!(h.reply(), "Question answered: staging, soon");
    let payload = h.script.interactions.lock()[0].payload.clone();
    assert_eq!(payload["kind"], "user_question");
    assert_eq!(payload["questions"][0]["id"], "turn-1:question-1");
    assert_eq!(payload["questions"][0]["options"][1]["value"], "production");
    h.resolve(Ok(json!({ "answers": { "q": { "selected": [1] } } })));
    h.start("ask_user").await;
    h.settle().await;
    assert_eq!(h.reply(), "Question answered: no answer");
    h.resolve(Err(RunnerError::failed("nope")));
    h.start("ask_user").await;
    h.settle().await;
    assert_eq!(h.errors(), ["request failed: RunnerError: nope"]);
}

#[tokio::test(start_paused = true)]
async fn adapter_surface() {
    let adapter = create_echo_adapter();
    assert_eq!(adapter.id(), ProviderId::Echo);
    let status = adapter.status().await.unwrap();
    assert_eq!(status.version.as_deref(), Some("1.0.0"));
    assert_eq!(status.auth, ProviderAuth::Ready);
    assert!(status.installed);
    let models = serde_json::to_value(adapter.list_models(None).await.unwrap()).unwrap();
    let efforts = json!([
        { "reasoningEffort": "low", "description": "Low reasoning effort" },
        { "reasoningEffort": "medium", "description": "Medium reasoning effort" },
        { "reasoningEffort": "high", "description": "High reasoning effort" },
    ]);
    let model = |id: &str, name: &str, default: bool| {
        json!({
            "id": id,
            "model": id,
            "displayName": name,
            "description": "Scripted provider for development and tests",
            "supportedReasoningEfforts": efforts,
            "defaultReasoningEffort": "medium",
            "isDefault": default,
        })
    };
    let expected = json!({
        "models": [model("echo-1", "Echo", true), model("echo-2", "Echo Two", false)],
        "selectedOnlyModels": [],
    });
    assert_eq!(models, expected);
    let h = open().await;
    assert!(h.session.can_apply(&spec("/work", None), &options()));
    assert!(!h.session.can_apply(&spec("/elsewhere", None), &options()));
    assert!(h.session.supports_rename());
    h.session.rename("New title").await.unwrap();
    assert_eq!(h.of_type("thread/name/updated").len(), 1);
}
