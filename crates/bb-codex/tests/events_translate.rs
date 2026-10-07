mod replay;

use std::sync::Arc;

use bb_codex::events::{CodexTranslator, InjectedTools, error_info, thread_name};
use parking_lot::Mutex;
use replay::{RecordingHooks, builder, collector};
use serde_json::{Value, json};

struct Harness {
    translator: CodexTranslator,
    events: Arc<Mutex<Vec<Value>>>,
    hooks: Arc<RecordingHooks>,
}

impl Harness {
    fn new(injected: InjectedTools, resumed: bool) -> Self {
        let (sink, events) = collector();
        let hooks = Arc::new(RecordingHooks::default());
        *hooks.root.lock() = Some("root".to_owned());
        let events_builder = builder(sink);
        events_builder.identity("root");
        let translator = CodexTranslator::new(events_builder, injected, hooks.clone(), resumed);
        Self { translator, events, hooks }
    }

    fn started() -> Self {
        let mut harness = Self::new(InjectedTools::new(), false);
        harness.translator.open_turn("root", "t1");
        harness
    }

    fn send(&mut self, method: &str, params: Value) -> bool {
        self.translator.handle(method, &params)
    }

    fn item(&mut self, method: &str, item: Value) -> bool {
        self.send(method, json!({ "threadId": "root", "turnId": "t1", "item": item }))
    }

    fn of_type(&self, kind: &str) -> Vec<Value> {
        let events = self.events.lock();
        events.iter().filter(|e| e["type"] == kind).cloned().collect()
    }

    fn completed(&self) -> Value {
        self.of_type("item/completed").pop().expect("a completed item")["item"].clone()
    }
}

#[test]
fn unknown_or_malformed_traffic_is_dropped_without_events() {
    let mut harness = Harness::started();
    let before = harness.events.lock().len();
    assert!(!harness.send("made/up", json!({})));
    assert!(!harness.send("item/started", json!("not an object")));
    assert!(!harness.send("turn/completed", json!({ "threadId": "root", "turn": { "id": 1 } })));
    assert!(!harness.item("item/completed", json!({ "type": "brandNew", "id": "x" })));
    assert!(!harness.item("item/completed", json!({ "type": "agentMessage", "id": "x" })));
    assert!(!harness.send("item/agentMessage/delta", json!({ "threadId": "root" })));
    assert_eq!(harness.events.lock().len(), before);
    assert!(harness.item("item/started", json!({ "type": "userMessage", "id": "u" })));
    assert_eq!(harness.events.lock().len(), before);
}

#[test]
fn mcp_tool_calls_carry_server_arguments_error_and_progress() {
    let mut harness = Harness::started();
    let call = json!({
        "type": "mcpToolCall", "id": "m1", "server": "docs", "tool": "lookup",
        "arguments": { "q": "rust" }, "status": "failed", "durationMs": 12,
        "error": { "message": "boom" }, "extra": true,
    });
    assert!(harness.item("item/started", call.clone()));
    let progress = json!({ "threadId": "root", "turnId": "t1", "itemId": "m1", "message": "50%" });
    assert!(harness.send("item/mcpToolCall/progress", progress));
    assert!(harness.item("item/completed", call));
    let item = harness.completed();
    assert_eq!(item["type"], "toolCall");
    assert_eq!(item["server"], "docs");
    assert_eq!(item["arguments"], json!({ "q": "rust" }));
    assert_eq!(item["error"], "boom");
    assert_eq!(item["durationMs"], 12);
    assert_eq!(item["status"], "failed");
    assert!(item.get("extra").is_none());
    assert_eq!(item["presentation"]["label"]["pending"], "Running lookup");
}

#[test]
fn injected_dynamic_tools_are_bb_tools_and_failures_report_their_output() {
    let injected = InjectedTools::from([("ask".to_owned(), None)]);
    let mut harness = Harness::new(injected, false);
    harness.translator.open_turn("root", "t1");
    let call = json!({
        "type": "dynamicToolCall", "id": "d1", "tool": "ask", "status": "completed",
        "durationMs": null, "success": false,
        "contentItems": [{ "text": "no" }, { "imageUrl": "http://x/y.png" }, { "text": " " }],
    });
    assert!(harness.item("item/completed", call));
    let item = harness.completed();
    assert_eq!(item["server"], "bb");
    assert_eq!(item["result"], "no\n[image: http://x/y.png]");
    assert_eq!(item["error"], "no\n[image: http://x/y.png]");
    let bare = json!({
        "type": "dynamicToolCall", "id": "d2", "tool": "other", "status": "completed",
        "durationMs": 3, "success": false, "contentItems": null,
    });
    assert!(harness.item("item/completed", bare));
    let item = harness.completed();
    assert!(item.get("server").is_none());
    assert_eq!(item["error"], "Dynamic tool call failed");
}

#[test]
fn web_actions_become_searches_or_fetches() {
    let mut harness = Harness::started();
    let search = |id: &str, action: Value| json!({ "type": "webSearch", "id": id, "query": "rust", "action": action });
    let queries = json!({ "type": "search", "queries": ["a", "rust"], "query": "a" });
    assert!(harness.item("item/completed", search("w1", queries)));
    assert_eq!(harness.completed()["queries"], json!(["a", "rust"]));
    let find = json!({ "type": "findInPage", "url": "https://x.dev", "pattern": "fn" });
    assert!(harness.item("item/completed", search("w2", find)));
    let item = harness.completed();
    assert_eq!((item["type"].clone(), item["pattern"].clone()), (json!("webFetch"), json!("fn")));
    let before = harness.events.lock().len();
    assert!(harness.item("item/completed", search("w3", json!({ "type": "other" }))));
    assert!(harness.item("item/completed", search("w4", Value::Null)));
    assert!(!harness.item("item/completed", search("w5", json!({ "type": "openPage" }))));
    assert_eq!(harness.events.lock().len(), before);
}

#[test]
fn collab_calls_delegate_to_child_threads_or_fall_back_to_tool_calls() {
    let mut harness = Harness::started();
    let spawn = json!({
        "type": "collabAgentToolCall", "id": "c1", "tool": "spawnAgent", "status": "completed",
        "senderThreadId": "root", "receiverThreadIds": ["child"], "prompt": " Review ",
        "model": null, "reasoningEffort": null, "agentsStates": { "child": { "done": true } },
    });
    assert!(harness.item("item/completed", spawn));
    let item = harness.completed();
    assert_eq!(item["type"], "delegation");
    assert_eq!(item["label"], "Review");
    assert_eq!(item["summary"], "child: {\"done\":true}");
    harness.translator.open_turn("child", "t2");
    let child_turn = harness.of_type("turn/started").pop().expect("child turn");
    assert!(child_turn.to_string().contains("parent"), "{child_turn}");
    let wait = json!({
        "type": "collabAgentToolCall", "id": "c2", "tool": "wait", "status": "inProgress",
        "senderThreadId": "root", "receiverThreadIds": [], "prompt": null,
        "model": "m", "reasoningEffort": "high", "agentsStates": {},
    });
    assert!(harness.item("item/started", wait));
    let started = harness.of_type("item/started").pop().expect("started")["item"].clone();
    assert_eq!(started["type"], "toolCall");
    let arguments = json!({
        "senderThreadId": "root", "receiverThreadIds": [], "model": "m", "reasoningEffort": "high",
    });
    assert_eq!(started["arguments"], arguments);
    assert_eq!(started["presentation"]["label"]["pending"], "Waiting for agents");
}

#[test]
fn plan_updates_close_a_plan_steps_item() {
    let mut harness = Harness::started();
    let plan = json!({
        "turnId": "t1", "explanation": "why",
        "plan": [{ "step": "one", "status": "completed" }, { "step": "two", "status": "inProgress" }],
    });
    assert!(harness.send("turn/plan/updated", plan));
    let item = harness.completed();
    assert_eq!(item["type"], "planSteps");
    assert_eq!(item["steps"][1], json!({ "step": "two", "status": "active" }));
    assert_eq!(item["explanation"], "why");
    assert_eq!(item["presentation"]["title"], "two");
}

#[test]
fn retried_errors_lend_their_classification_to_the_final_other_error() {
    let mut harness = Harness::started();
    let error = |info: Value, retry: bool| {
        json!({
            "threadId": "root", "turnId": "t1", "willRetry": retry,
            "error": { "message": "limit", "codexErrorInfo": info, "additionalDetails": null },
        })
    };
    assert!(harness.send("error", error(json!({ "usageLimitExceeded": null }), true)));
    assert!(harness.hooks.terminal_errors.lock().is_empty());
    assert!(harness.send("error", error(json!("other"), false)));
    let last = harness.of_type("provider/error").pop().expect("error event");
    assert_eq!(last["errorInfo"]["category"], "rate-limit");
    assert_eq!(last["detail"], "limit");
    let terminal = harness.hooks.terminal_errors.lock().clone();
    assert_eq!(terminal, vec![("rate-limit".to_owned(), "limit".to_owned())]);
}

#[test]
fn error_info_classifies_codes_and_http_statuses() {
    let info = json!({ "responseStreamDisconnected": { "httpStatusCode": 502 } });
    let expected = json!({
        "category": "stream-disconnected",
        "providerCode": "responseStreamDisconnected",
        "httpStatusCode": 502,
    });
    assert_eq!(error_info(Some(&info)), Some(expected));
    assert_eq!(error_info(Some(&json!("weird"))).expect("info")["category"], "unknown");
    assert_eq!(error_info(Some(&Value::Null)), None);
    assert_eq!(thread_name("[bb] Title"), "Title");
}

#[test]
fn replayed_usage_on_resume_only_updates_the_context_window() {
    let mut harness = Harness::new(InjectedTools::new(), true);
    let usage = json!({
        "totalTokens": 10, "inputTokens": 8, "cachedInputTokens": 4,
        "outputTokens": 2, "reasoningOutputTokens": 0,
    });
    let params = json!({
        "threadId": "root", "turnId": "old",
        "tokenUsage": { "total": usage, "last": usage, "modelContextWindow": 100 },
    });
    assert!(harness.send("thread/tokenUsage/updated", params.clone()));
    assert!(harness.of_type("thread/tokenUsage/updated").is_empty());
    let window = harness.of_type("thread/contextWindowUsage/updated").pop().expect("window");
    let expected = json!({ "usedTokens": 10, "modelContextWindow": 100, "estimated": false });
    assert_eq!(window["contextWindowUsage"], expected);
    harness.translator.open_turn("root", "t1");
    assert!(harness.send("thread/tokenUsage/updated", params));
    let tokens = harness.of_type("thread/tokenUsage/updated").pop().expect("usage");
    assert_eq!(tokens["tokenUsage"]["last"]["cacheReadInputTokens"], 4);
}

#[test]
fn thread_metadata_only_follows_the_root_thread() {
    let mut harness = Harness::started();
    assert!(harness.send("thread/started", json!({ "thread": { "id": "child" } })));
    assert!(harness.send("thread/name/updated", json!({ "threadId": "child", "threadName": "x" })));
    assert!(harness.of_type("thread/started").is_empty());
    let rename = json!({ "threadId": "root", "threadName": "[bb] Named" });
    assert!(harness.send("thread/name/updated", rename));
    assert!(harness.events.lock().iter().any(|e| e.to_string().contains("\"Named\"")));
    let goal = json!({ "goal": {
        "objective": "ship", "status": "active", "tokenBudget": null,
        "tokensUsed": 1, "timeUsedSeconds": 2, "extra": 1,
    } });
    assert!(harness.send("thread/goal/updated", goal));
    assert!(harness.send("thread/goal/cleared", Value::Null));
    assert_eq!(harness.of_type("thread/extensionState/updated").len(), 2);
    assert!(harness.send("configWarning", json!({ "summary": "s", "details": "" })));
    assert!(harness.send("warning", json!({ "message": "w" })));
    assert_eq!(harness.of_type("provider/warning").len(), 2);
    assert!(!harness.send("thread/closed", json!({ "threadId": "root" })));
}

#[test]
fn declined_file_changes_close_as_interrupted() {
    let mut harness = Harness::started();
    let change = json!({
        "type": "fileChange", "id": "f1", "status": "declined",
        "changes": [{ "path": "/a/b.rs", "diff": "", "kind": { "type": "update", "move_path": "/a/c.rs" } }],
    });
    assert!(harness.item("item/completed", change));
    let item = harness.completed();
    assert_eq!(item["status"], "interrupted");
    assert_eq!(
        item["changes"][0],
        json!({ "path": "/a/b.rs", "kind": "update", "movePath": "/a/c.rs" })
    );
}
