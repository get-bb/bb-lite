use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use bb_core::{
    ExecutionOptions, ProviderAuth, ProviderId, ProviderModels, ProviderStatus, RunnerErrorCode,
    RunnerEvent, RunnerEventBody, RunnerResult, SessionSpec, SubmitTurnArgs, SubmitTurnMode,
    SubmitTurnResult, ToolCallOutputItem,
};
use bb_provider::{
    ApprovalEnforcer, ExitInfo, Interaction, ProviderAdapter, ProviderSession, SessionHost,
    SteerInput, SteerOutcome, ToolCall, TurnInput,
};
use bb_remote::outbox::Outbox;
use bb_sessions::{
    ListModelsArgs, ResolveInteractionArgs, ResolveToolCallArgs, SessionManager,
    SessionManagerOptions, SessionTiming, ThreadArgs,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

const THREAD: &str = "thr_echo";
const PROVIDER_THREAD: &str = "echo-thr_echo";

#[derive(Default)]
struct Script {
    replies: Mutex<Vec<String>>,
    counts: Mutex<HashMap<String, u32>>,
    url: Mutex<Option<String>>,
}

struct FakeAdapter {
    script: Arc<Script>,
}

struct FakeSession {
    this: Weak<FakeSession>,
    host: SessionHost,
    provider_thread_id: String,
    script: Arc<Script>,
    ignore_interrupt: AtomicBool,
}

#[async_trait]
impl ProviderAdapter for FakeAdapter {
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
            version: None,
            auth: ProviderAuth::Ready,
            message: None,
        })
    }
    async fn list_models(&self, _cwd: Option<&str>) -> RunnerResult<ProviderModels> {
        Ok(ProviderModels::default())
    }
    async fn open(
        &self,
        spec: SessionSpec,
        _options: ExecutionOptions,
        host: SessionHost,
    ) -> RunnerResult<Arc<dyn ProviderSession>> {
        *self.script.url.lock() = host.env.get("URL").cloned();
        let resumed = spec.provider_thread_id.clone();
        let provider_thread_id =
            resumed.clone().unwrap_or_else(|| format!("echo-{}", spec.thread_id));
        host.events.identity(&provider_thread_id);
        if resumed.is_none() {
            host.events.started();
        }
        let script = self.script.clone();
        Ok(Arc::new_cyclic(|this| FakeSession {
            this: this.clone(),
            host,
            provider_thread_id,
            script,
            ignore_interrupt: AtomicBool::new(false),
        }))
    }
}

fn text_of(input: &[Value]) -> String {
    input.first().and_then(|i| i["text"].as_str()).unwrap_or_default().to_owned()
}

impl FakeSession {
    async fn run(self: Arc<Self>, text: String, client_request_id: String) {
        tokio::time::sleep(Duration::from_millis(1)).await;
        let events = &self.host.events;
        if text == "swallow_turn" {
            return;
        }
        let turn = events.open_turn(None, None);
        events.accept_input(&client_request_id, None);
        if text == "crash" {
            let message = "exit code 1".into();
            self.host.on_exit(ExitInfo { message, stderr_tail: "scripted crash".into() });
            return;
        }
        if text == "hold_turn" {
            return;
        }
        let reply = if text.contains("approve") {
            let payload = json!({ "kind": "approval", "subject": { "kind": "command" } });
            let asked = Interaction { payload, turn_id: Some(turn) };
            match self.host.request_interaction(asked).await {
                Ok(answer) if answer["decision"] == "deny" => "Denied".to_owned(),
                Ok(_) => format!("Response to: {text}"),
                Err(_) => return,
            }
        } else if let Some(tool) = text.strip_prefix("call_tool:") {
            let call = ToolCall {
                call_id: "call-1".into(),
                tool: tool.into(),
                arguments: json!({}),
                turn_id: Some(turn),
            };
            let Ok(result) = self.host.call_tool(call).await else { return };
            let ToolCallOutputItem::InputText { text: output } = &result.content_items[0] else {
                return;
            };
            format!("Tool called: {tool} = {output}")
        } else if text == "count" {
            let mut counts = self.script.counts.lock();
            let count = counts.entry(self.provider_thread_id.clone()).or_default();
            *count += 1;
            format!("Turn count: {count}")
        } else {
            format!("Response to: {text}")
        };
        self.script.replies.lock().push(reply);
        events.close_turn(None, "completed", None, None);
    }
}

#[async_trait]
impl ProviderSession for FakeSession {
    fn provider_thread_id(&self) -> String {
        self.provider_thread_id.clone()
    }
    fn can_apply(&self, _spec: &SessionSpec, _options: &ExecutionOptions) -> bool {
        true
    }
    async fn start_turn(&self, args: TurnInput) -> RunnerResult<()> {
        let state = std::path::Path::new(&self.host.thread_storage_dir).join("echo-state.json");
        std::fs::write(state, "{}")?;
        let text = text_of(&args.input);
        if text.contains("ignore_interrupt") {
            self.ignore_interrupt.store(true, Ordering::SeqCst);
        }
        if let Some(this) = self.this.upgrade() {
            tokio::spawn(this.run(text, args.client_request_id));
        }
        Ok(())
    }
    async fn steer(&self, args: SteerInput) -> RunnerResult<SteerOutcome> {
        let events = &self.host.events;
        if events.active_turn_id().as_deref() != Some(args.expected_turn_id.as_str()) {
            return Ok(SteerOutcome::Stale);
        }
        events.accept_input(&args.client_request_id, None);
        let text = text_of(&args.input);
        self.script.replies.lock().push(format!("Steered: {text}"));
        if text == "release_turn" {
            events.close_turn(None, "completed", None, None);
        }
        Ok(SteerOutcome::Steered)
    }
    async fn interrupt(&self) -> RunnerResult<()> {
        if !self.ignore_interrupt.load(Ordering::SeqCst) {
            self.host.events.close_turn(None, "interrupted", None, None);
        }
        Ok(())
    }
    async fn close(&self) -> RunnerResult<()> {
        Ok(())
    }
}

struct Kit {
    api: SessionManager,
    data_dir: tempfile::TempDir,
    outbox: Arc<Outbox>,
    received: Arc<Mutex<Vec<RunnerEvent>>>,
    script: Arc<Script>,
    counter: AtomicU64,
}

fn options() -> ExecutionOptions {
    serde_json::from_value(json!({
        "model": "echo-1", "reasoningLevel": "medium", "serviceTier": "default",
        "permissionMode": "accept-edits", "permissionEscalation": "ask", "providerOptions": {}
    }))
    .unwrap()
}

async fn until<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    for _ in 0..20_000 {
        if let Some(value) = probe() {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition never held");
}

async fn expect_code<T: std::fmt::Debug>(
    call: impl Future<Output = RunnerResult<T>>,
    code: RunnerErrorCode,
) {
    assert_eq!(call.await.unwrap_err().code, code);
}

impl Kit {
    fn new(timing: SessionTiming) -> Self {
        let data_dir = tempfile::tempdir().unwrap();
        let received = Arc::new(Mutex::new(Vec::new()));
        let sink = received.clone();
        let outbox = Outbox::with_flush_ms(Arc::new(move |e| sink.lock().push(e)), 5);
        let script = Arc::new(Script::default());
        let api = SessionManager::new(SessionManagerOptions {
            data_dir: data_dir.path().to_path_buf(),
            server_url: "http://127.0.0.1:48901".into(),
            bb_cli_path: "/opt/bb/bin/bb".into(),
            outbox: outbox.clone(),
            adapters: vec![Arc::new(FakeAdapter { script: script.clone() })],
            terminal_ids: None,
            login_path: Some(Arc::new(|| Box::pin(async { Some("/usr/bin:/bin".to_owned()) }))),
            timing,
        });
        Self { api, data_dir, outbox, received, script, counter: AtomicU64::new(0) }
    }

    fn turn(
        &self,
        text: &str,
        mode: SubmitTurnMode,
        provider_thread_id: Option<&str>,
    ) -> SubmitTurnArgs {
        let count = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        serde_json::from_value(json!({
            "session": {
                "threadId": THREAD, "providerId": "echo", "cwd": "/work",
                "providerThreadId": provider_thread_id, "instructions": "", "dynamicTools": [],
                "env": { "BB_THREAD_ID": THREAD, "API_TOKEN": "secret", "URL": "{BB_SERVER_URL}/x" },
                "skillDirs": []
            },
            "clientRequestId": format!("req-{count}"),
            "input": [{ "type": "text", "text": text, "mentions": [] }],
            "options": options(),
            "mode": mode,
        }))
        .unwrap()
    }

    fn events(&self) -> Vec<Value> {
        let received = self.received.lock();
        let thread_events = received.iter().filter_map(|e| match &e.body {
            RunnerEventBody::ThreadEvents { events, .. } => Some(events.clone()),
            _ => None,
        });
        thread_events.flatten().collect()
    }

    fn of_type(&self, kind: &str) -> Vec<Value> {
        self.events().into_iter().filter(|e| e["type"] == kind).collect()
    }

    fn of_kind(&self, kind: &str) -> Vec<Value> {
        let received = self.received.lock();
        let matching = received.iter().filter(|e| e.body.kind() == kind);
        matching.map(|e| serde_json::to_value(&e.body).unwrap()).collect()
    }

    fn replies(&self) -> Vec<String> {
        self.script.replies.lock().clone()
    }

    async fn completed(&self, count: usize) {
        until(|| (self.of_type("turn/completed").len() >= count).then_some(())).await;
    }

    async fn active_turn(&self) -> String {
        loop {
            let snapshot = self.api.snapshot().await.unwrap();
            if let Some(id) = snapshot.sessions.first().and_then(|s| s.active_turn_id.clone()) {
                return id;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn stop(&self) -> impl Future<Output = RunnerResult<bb_sessions::Interrupted>> + '_ {
        self.api.interrupt_turn(ThreadArgs { thread_id: THREAD.into() })
    }
}

fn steer(turn_id: &str) -> SubmitTurnMode {
    SubmitTurnMode::Steer { expected_turn_id: turn_id.into() }
}

#[tokio::test(start_paused = true)]
async fn runs_a_turn_through_the_reliable_outbox() {
    let kit = Kit::new(SessionTiming::default());
    let started = kit.api.submit_turn(kit.turn("hello", SubmitTurnMode::Start, None)).await;
    let provider_thread_id = PROVIDER_THREAD.to_owned();
    assert_eq!(started.unwrap(), SubmitTurnResult::Started { provider_thread_id });
    kit.completed(1).await;
    let shape: Vec<String> =
        kit.events().iter().map(|e| e["type"].as_str().unwrap().into()).collect();
    let expected = ["thread/identity", "thread/started", "provider.env-resolved", "turn/started"];
    assert_eq!(shape[..4], expected);
    assert_eq!(kit.replies(), ["Response to: hello"]);
    let resolved = &kit.of_type("provider.env-resolved")[0];
    assert_eq!(resolved["providerThreadId"], PROVIDER_THREAD);
    let entries = resolved["entries"].as_array().unwrap();
    let entry = |name: &str| entries.iter().find(|e| e["name"] == name).unwrap()["value"].clone();
    let storage = kit.data_dir.path().join("thread-storage").join(THREAD);
    assert_eq!(entry("PATH"), "/opt/bb/bin:/usr/bin:/bin");
    assert_eq!(entry("BB_CLI"), "/opt/bb/bin/bb");
    assert_eq!(entry("BB_SERVER_URL"), "http://127.0.0.1:48901");
    assert_eq!(entry("BB_THREAD_STORAGE"), storage.to_string_lossy().as_ref());
    assert_eq!(entry("BB_THREAD_ID"), THREAD);
    assert_eq!(kit.script.url.lock().as_deref(), Some("http://127.0.0.1:48901/x"));
    assert_eq!(entry("API_TOKEN")["masked"], true);

    let seqs: Vec<u64> = kit.received.lock().iter().map(|e| e.seq.unwrap()).collect();
    assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());
    let snapshot = kit.api.snapshot().await.unwrap();
    assert_eq!(snapshot.last_event_seq, seqs.len() as u64);
    assert_eq!(snapshot.sessions[0].provider_thread_id, PROVIDER_THREAD);
    assert_eq!(snapshot.sessions[0].active_turn_id, None);
    let ack = json!({ "seq": seqs.len() - 2 });
    assert_eq!(kit.api.call("ackEvents", ack).await.unwrap().unwrap(), Value::Null);
    kit.received.lock().clear();
    kit.outbox.resend_after(0);
    let resent: Vec<u64> = kit.received.lock().iter().map(|e| e.seq.unwrap()).collect();
    assert_eq!(resent, seqs[seqs.len() - 2..]);

    let described = kit.api.call("describe", Value::Null).await.unwrap().unwrap();
    assert_eq!(described["dataDir"], kit.data_dir.path().to_string_lossy().as_ref());
    assert_eq!(described["version"], "0.0.1");
    let providers = kit.api.call("listProviders", Value::Null).await.unwrap().unwrap();
    assert_eq!(providers[0]["auth"], "ready");
    let unknown = ListModelsArgs { provider_id: ProviderId::Codex, cwd: None };
    expect_code(kit.api.list_models(unknown), RunnerErrorCode::Unavailable).await;
    assert!(kit.api.call("gitStatus", json!({})).await.is_none());
    kit.api.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn applies_the_start_steer_and_auto_rules() {
    let kit = Kit::new(SessionTiming::default());
    kit.api.submit_turn(kit.turn("hold_turn", SubmitTurnMode::Start, None)).await.unwrap();
    let turn_id = kit.active_turn().await;
    let again = kit.api.submit_turn(kit.turn("again", SubmitTurnMode::Start, None));
    expect_code(again, RunnerErrorCode::CompetingTurn).await;
    let wrong = kit.api.submit_turn(kit.turn("nudge", steer("da00000000-t9"), None));
    expect_code(wrong, RunnerErrorCode::StaleTurn).await;
    let auto = kit.api.submit_turn(kit.turn("nudge", SubmitTurnMode::Auto, None)).await.unwrap();
    let provider_thread_id = PROVIDER_THREAD.to_owned();
    let steered = SubmitTurnResult::Steered { provider_thread_id, turn_id: turn_id.clone() };
    assert_eq!(auto, steered);
    let release = kit.turn("release_turn", steer(&turn_id), None);
    let (first, second) =
        tokio::join!(kit.api.submit_turn(release.clone()), kit.api.submit_turn(release));
    assert_eq!(first.unwrap(), second.unwrap());
    kit.completed(1).await;
    let accepted: Vec<Value> =
        kit.of_type("turn/input/accepted").into_iter().map(|e| e["scope"].clone()).collect();
    assert_eq!(accepted, vec![json!({ "kind": "turn", "turnId": turn_id }); 3]);
    assert_eq!(kit.replies(), ["Steered: nudge", "Steered: release_turn"]);
    let late = kit.api.submit_turn(kit.turn("late", steer(&turn_id), None));
    expect_code(late, RunnerErrorCode::StaleTurn).await;
    let next = kit.api.submit_turn(kit.turn("fresh", SubmitTurnMode::Auto, None)).await.unwrap();
    assert!(matches!(next, SubmitTurnResult::Started { .. }));
    kit.completed(2).await;
    assert_eq!(kit.of_type("turn/started").len(), 2);
    kit.api.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn interrupts_through_the_provider_and_settles_itself() {
    let kit = Kit::new(SessionTiming::default());
    assert!(!kit.stop().await.unwrap().interrupted);
    kit.api.submit_turn(kit.turn("hold_turn", SubmitTurnMode::Start, None)).await.unwrap();
    kit.active_turn().await;
    assert!(kit.stop().await.unwrap().interrupted);
    assert_eq!(kit.of_type("turn/completed")[0]["status"], "interrupted");
    assert!(kit.api.snapshot().await.unwrap().sessions.is_empty());

    let stubborn =
        kit.turn("ignore_interrupt approve go", SubmitTurnMode::Start, Some(PROVIDER_THREAD));
    kit.api.submit_turn(stubborn).await.unwrap();
    let request = until(|| kit.of_kind("interaction.requested").first().cloned()).await;
    let request_id = request["requestId"].as_str().unwrap().to_owned();
    assert_eq!(
        kit.api.snapshot().await.unwrap().pending_request_ids,
        std::slice::from_ref(&request_id)
    );
    let before = tokio::time::Instant::now();
    assert!(kit.stop().await.unwrap().interrupted);
    assert!(before.elapsed() >= Duration::from_secs(5));
    let settled = kit.of_type("turn/completed").pop().unwrap();
    assert_eq!(settled["status"], "interrupted");
    assert_eq!(settled["scope"]["turnId"], request["turnId"]);
    let cancelled = kit.of_kind("interaction.cancelled");
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0]["requestId"], request_id.as_str());
    let late = ResolveInteractionArgs {
        thread_id: THREAD.into(),
        request_id,
        resolution: json!({ "decision": "deny" }),
    };
    assert!(!kit.api.resolve_interaction(late).await.unwrap().delivered);
    let snapshot = kit.api.snapshot().await.unwrap();
    assert!(snapshot.sessions.is_empty() && snapshot.pending_request_ids.is_empty());
    kit.api.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn resumes_a_released_session_from_its_provider_thread_id() {
    let kit = Kit::new(SessionTiming::default());
    let started = kit.api.submit_turn(kit.turn("count", SubmitTurnMode::Start, None)).await;
    let SubmitTurnResult::Started { provider_thread_id } = started.unwrap() else { panic!() };
    kit.completed(1).await;
    kit.api.release_session(ThreadArgs { thread_id: THREAD.into() }).await.unwrap();
    assert!(kit.api.snapshot().await.unwrap().sessions.is_empty());
    let resumed = kit.turn("count", SubmitTurnMode::Start, Some(&provider_thread_id));
    kit.api.submit_turn(resumed).await.unwrap();
    kit.completed(2).await;
    assert_eq!(kit.replies(), ["Turn count: 1", "Turn count: 2"]);
    assert_eq!(kit.of_type("thread/identity").len(), 2);
    assert_eq!(kit.of_type("thread/started").len(), 1);
    assert_eq!(kit.of_type("provider.env-resolved").len(), 2);
    kit.api.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn round_trips_approvals_and_denies_them_itself_when_told_to() {
    let kit = Kit::new(SessionTiming::default());
    let decisions = [
        json!({ "decision": "allow_once", "grantedPermissions": null }),
        json!({ "decision": "deny" }),
    ];
    for (index, resolution) in decisions.into_iter().enumerate() {
        kit.api.submit_turn(kit.turn("approve ship", SubmitTurnMode::Start, None)).await.unwrap();
        let request = until(|| kit.of_kind("interaction.requested").get(index).cloned()).await;
        assert_eq!(request["providerId"], "echo");
        assert_eq!(request["providerThreadId"], PROVIDER_THREAD);
        assert_eq!(request["turnId"], kit.active_turn().await.as_str());
        assert_eq!(request["payload"]["kind"], "approval");
        let received = kit.received.lock().clone();
        let opened = received.iter().position(|e| match &e.body {
            RunnerEventBody::ThreadEvents { events, .. } => {
                events.iter().any(|e| e["type"] == "turn/started")
            }
            _ => false,
        });
        let asked = received.iter().position(|e| e.body.kind() == "interaction.requested");
        assert!(opened.unwrap() < asked.unwrap());
        let delivery = ResolveInteractionArgs {
            thread_id: THREAD.into(),
            request_id: request["requestId"].as_str().unwrap().into(),
            resolution,
        };
        let first = kit.api.resolve_interaction(delivery.clone()).await.unwrap();
        let second = kit.api.resolve_interaction(delivery).await.unwrap();
        assert_eq!([first.delivered, second.delivered], [true, false]);
        kit.completed(index + 1).await;
    }
    let mut unattended = kit.turn("approve ship", SubmitTurnMode::Start, Some(PROVIDER_THREAD));
    unattended.options.permission_escalation = bb_core::PermissionEscalation::Deny;
    kit.api.submit_turn(unattended).await.unwrap();
    kit.completed(3).await;
    assert_eq!(kit.of_kind("interaction.requested").len(), 2);
    assert_eq!(kit.replies(), ["Response to: approve ship", "Denied", "Denied"]);
    kit.api.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn round_trips_a_dynamic_tool_call() {
    let kit = Kit::new(SessionTiming::default());
    kit.api.submit_turn(kit.turn("call_tool:lookup", SubmitTurnMode::Start, None)).await.unwrap();
    let request = until(|| kit.of_kind("toolCall.requested").first().cloned()).await;
    assert_eq!(request["tool"], "lookup");
    assert_eq!(request["arguments"], json!({}));
    assert_eq!(request["callId"], "call-1");
    assert_eq!(request["turnId"], kit.active_turn().await.as_str());
    let result =
        json!({ "success": true, "contentItems": [{ "type": "inputText", "text": "42" }] });
    let delivery = ResolveToolCallArgs {
        thread_id: THREAD.into(),
        request_id: request["requestId"].as_str().unwrap().into(),
        result: serde_json::from_value(result).unwrap(),
    };
    assert!(kit.api.resolve_tool_call(delivery).await.unwrap().delivered);
    kit.completed(1).await;
    assert_eq!(kit.replies(), ["Tool called: lookup = 42"]);
    kit.api.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn reports_provider_death_and_stalled_turns() {
    let kit = Kit::new(SessionTiming::default());
    kit.api.submit_turn(kit.turn("crash", SubmitTurnMode::Start, None)).await.unwrap();
    let exited = until(|| kit.of_type("system/error").first().cloned()).await;
    let failed = kit.of_type("turn/completed")[0].clone();
    assert_eq!(failed["status"], "failed");
    let message = failed["error"]["message"].as_str().unwrap();
    assert!(message.contains("exited unexpectedly"), "{message}");
    assert_eq!(exited["code"], "provider_process_exited");
    assert_eq!(exited["detail"], "stderr:\nscripted crash");
    assert_eq!(exited["scope"], failed["scope"]);
    until(|| kit.api_sessions_empty()).await;

    kit.api.submit_turn(kit.turn("swallow_turn", SubmitTurnMode::Start, None)).await.unwrap();
    let second = kit.api.submit_turn(kit.turn("second", SubmitTurnMode::Start, None));
    expect_code(second, RunnerErrorCode::CompetingTurn).await;
    let before = tokio::time::Instant::now();
    let stalled = until(|| kit.of_type("system/error").get(1).cloned()).await;
    assert!(before.elapsed() >= Duration::from_secs(105));
    assert_eq!(stalled["code"], "provider_turn_start_timeout");
    assert_eq!(stalled["scope"], json!({ "kind": "thread" }));
    let text = stalled["message"].as_str().unwrap();
    assert!(text.contains("within 120s."), "{text}");

    let storage = kit.data_dir.path().join("thread-storage").join(THREAD);
    assert!(storage.join("echo-state.json").exists());
    kit.api.delete_thread_storage(ThreadArgs { thread_id: THREAD.into() }).await.unwrap();
    assert!(!storage.exists());
    assert!(kit.api.snapshot().await.unwrap().sessions.is_empty());
    let escaping = kit.api.delete_thread_storage(ThreadArgs { thread_id: "../x".into() });
    expect_code(escaping, RunnerErrorCode::InvalidPath).await;
    kit.api.shutdown().await;
}

impl Kit {
    fn api_sessions_empty(&self) -> Option<()> {
        let empty = futures::executor::block_on(self.api.snapshot()).unwrap().sessions.is_empty();
        empty.then_some(())
    }
}
