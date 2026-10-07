mod replay;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bb_codex::adapter::{CodexAdapterOptions, create_codex_adapter};
use bb_codex::rpc::SpawnAppServer;
use bb_core::{
    ExecutionOptions, ProviderId, RunnerError, RunnerResult, SessionSpec, ToolCallResponse,
};
use bb_provider::{
    EventBuilder, ExitInfo, Interaction, ProviderAdapter, ProviderSession, SessionHost,
    SessionHostCallbacks, SteerInput, ToolCall, TurnInput,
};
use indexmap::IndexMap;
use parking_lot::Mutex;
use replay::{
    FakeAppServer, SCENARIOS, builder, fake_app_server, first_difference, intern_ids, kept,
    read_original_events, read_wire,
};
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

const NEVER_SENT: [&str; 2] = ["account/rateLimits/read", "skills/extraRoots/set"];
const IGNORED_PARAMS: [&str; 4] =
    ["serviceTier", "effort", "excludeTurns", "experimentalRawEvents"];
const RECORDER_ENV: &str = "shell_environment_policy.set.BB_PROVIDER_BRIDGE_RECORD_DIR";

#[derive(Default)]
struct Answers {
    pending: Mutex<VecDeque<oneshot::Sender<Value>>>,
}

impl Answers {
    async fn ask(&self) -> RunnerResult<Value> {
        let (send, receive) = oneshot::channel();
        self.pending.lock().push_back(send);
        receive.await.map_err(|_| RunnerError::failed("replay ended before an answer"))
    }
}

#[async_trait]
impl SessionHostCallbacks for Answers {
    async fn call_tool(&self, _call: ToolCall) -> RunnerResult<ToolCallResponse> {
        Ok(serde_json::from_value(self.ask().await?)?)
    }

    async fn request_interaction(&self, _interaction: Interaction) -> RunnerResult<Value> {
        self.ask().await
    }

    fn on_exit(&self, _info: ExitInfo) {}
}

async fn settle() {
    for _ in 0..3 {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

fn comparable(params: &Value) -> Map<String, Value> {
    let mut rest = params.as_object().cloned().unwrap_or_default();
    rest.retain(|key, _| !IGNORED_PARAMS.contains(&key.as_str()));
    let mut config = rest.get("config").and_then(Value::as_object).cloned().unwrap_or_default();
    config.remove(RECORDER_ENV);
    rest.insert("config".into(), Value::Object(config));
    if let Some(Value::Array(tools)) = rest.get_mut("dynamicTools") {
        tools.iter_mut().filter_map(Value::as_object_mut).for_each(|tool| {
            tool.remove("type");
        });
    }
    rest
}

struct Command {
    params: Value,
}

impl Command {
    fn str(&self, key: &str) -> String {
        self.params[key].as_str().unwrap_or_default().to_owned()
    }

    fn options(&self) -> (ExecutionOptions, String, IndexMap<String, String>) {
        let mut options = self.params["options"].as_object().cloned().unwrap_or_default();
        let instructions = options.remove("instructions");
        let env = options.remove("envVars");
        let escalation = options.remove("permissionEscalation").filter(|value| !value.is_null());
        options.insert("permissionEscalation".into(), escalation.unwrap_or_else(|| json!("ask")));
        let execution = serde_json::from_value(Value::Object(options)).expect("options");
        let instructions = instructions.and_then(|text| text.as_str().map(str::to_owned));
        let env = env.map(|env| serde_json::from_value(env).expect("envVars"));
        (execution, instructions.unwrap_or_default(), env.unwrap_or_default())
    }

    fn input(&self) -> Vec<Value> {
        self.params["input"].as_array().cloned().unwrap_or_default()
    }
}

type Opening = tokio::task::JoinHandle<RunnerResult<Arc<dyn ProviderSession>>>;

struct Replay {
    scenario: String,
    adapter: Arc<dyn ProviderAdapter>,
    server: Arc<Mutex<Option<FakeAppServer>>>,
    answers: Arc<Answers>,
    failures: Arc<Mutex<Vec<String>>>,
    mismatches: Vec<String>,
    events: Arc<Mutex<Vec<Value>>>,
    builder: Option<Arc<EventBuilder>>,
    opening: Option<Opening>,
    session: Option<Arc<dyn ProviderSession>>,
    live_ids: HashMap<String, Value>,
    skipped: HashSet<String>,
}

impl Replay {
    fn new(scenario: &str) -> Self {
        let server: Arc<Mutex<Option<FakeAppServer>>> = Arc::default();
        let slot = server.clone();
        let spawn: SpawnAppServer = Arc::new(move |command, args, _launch| {
            assert_eq!((command, args.join(" ").as_str()), ("codex-replay", "app-server"));
            let (fake, child) = fake_app_server();
            *slot.lock() = Some(fake);
            child
        });
        let options =
            CodexAdapterOptions { spawn: Some(spawn), command: Some("codex-replay".into()) };
        Self {
            scenario: scenario.to_owned(),
            adapter: create_codex_adapter(options),
            server,
            answers: Arc::default(),
            failures: Arc::default(),
            mismatches: Vec::new(),
            events: Arc::default(),
            builder: None,
            opening: None,
            session: None,
            live_ids: HashMap::new(),
            skipped: HashSet::new(),
        }
    }

    fn track<T: Send + 'static>(
        &self,
        work: impl Future<Output = RunnerResult<T>> + Send + 'static,
    ) {
        let failures = self.failures.clone();
        tokio::spawn(async move {
            if let Err(error) = work.await {
                failures.lock().push(error.message);
            }
        });
    }

    async fn session(&mut self) -> Option<Arc<dyn ProviderSession>> {
        if let Some(opening) = self.opening.take() {
            match opening.await.expect("open task") {
                Ok(session) => self.session = Some(session),
                Err(error) => self.failures.lock().push(error.message),
            }
        }
        self.session.clone()
    }

    async fn close(&mut self) {
        let session = self.session().await;
        self.session = None;
        if let Some(session) = session {
            session.close().await.expect("close");
        }
    }

    fn open(&mut self, command: &Command) {
        let events = self.events.clone();
        let builder = builder(Arc::new(move |event| events.lock().push(event)));
        self.builder = Some(builder.clone());
        let (execution, instructions, env) = command.options();
        let host = SessionHost {
            events: builder,
            env,
            process_env: IndexMap::new(),
            thread_storage_dir: "/unused".into(),
            writable_roots: Vec::new(),
            callbacks: self.answers.clone(),
        };
        let provider_thread_id = command.params["providerThreadId"].as_str().map(str::to_owned);
        let tools = command.params.get("dynamicTools").cloned().unwrap_or_else(|| json!([]));
        let spec = SessionSpec {
            thread_id: command.str("threadId"),
            provider_id: ProviderId::Codex,
            cwd: command.str("cwd"),
            provider_thread_id,
            instructions,
            dynamic_tools: serde_json::from_value(tools).expect("dynamicTools"),
            env: IndexMap::new(),
            skill_dirs: Vec::new(),
        };
        self.live_ids.clear();
        self.skipped.clear();
        let adapter = self.adapter.clone();
        self.opening = Some(tokio::spawn(async move { adapter.open(spec, execution, host).await }));
    }

    async fn runtime(&mut self, message: &Value) {
        let Some(method) = message["method"].as_str() else {
            if message.get("id").is_some()
                && let Some(answer) = self.answers.pending.lock().pop_front()
            {
                let _ = answer.send(message["result"].clone());
            }
            return;
        };
        let command = Command { params: message["params"].clone() };
        if method == "thread/start" || method == "thread/resume" {
            self.close().await;
            return self.open(&command);
        }
        let Some(session) = self.session().await else { return };
        let Some(builder) = self.builder.clone() else { return };
        if method == "thread/stop" {
            if command.params["intent"] == "interrupt" {
                let session = session.clone();
                self.track(async move { session.interrupt().await });
            } else {
                self.close().await;
            }
        }
        if method != "turn/start" && method != "turn/steer" {
            return;
        }
        let (client_request_id, input) = (command.str("clientRequestId"), command.input());
        let options = command.options().0;
        if method == "turn/start" {
            let turn = TurnInput { client_request_id, input, options };
            self.track(async move { session.start_turn(turn).await });
        } else {
            let expected = builder.bb_turn_id(&command.str("expectedTurnId")).unwrap_or_default();
            let steer =
                SteerInput { client_request_id, input, options, expected_turn_id: expected };
            self.track(async move { session.steer(steer).await });
        }
    }

    async fn sent(&self, describe: &str, matches: impl Fn(&Value) -> bool) -> Value {
        for attempt in 0..500 {
            if let Some(failure) = self.failures.lock().first() {
                panic!("{}: {failure}", self.scenario);
            }
            let found = self.server.lock().as_ref().and_then(|server| {
                let mut written = server.written.lock();
                let index = written.iter().position(&matches)?;
                Some(written.remove(index))
            });
            if let Some(message) = found {
                return message;
            }
            if attempt < 20 {
                settle().await
            } else {
                tokio::time::sleep(Duration::from_millis(2)).await
            }
        }
        panic!("{}: the adapter never sent {describe}", self.scenario);
    }

    async fn client(&mut self, message: &Value) {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let Some(method) = message["method"].as_str() else {
            let describe = format!("a response to {id}");
            let answer = self.sent(&describe, |m| m["id"] == id && m.get("method").is_none()).await;
            if answer["result"] != message["result"] {
                self.mismatches.push(format!("response {id}: {}", answer["result"]));
            }
            return;
        };
        if NEVER_SENT.contains(&method) {
            self.skipped.insert(id.to_string());
            return;
        }
        let request = self.sent(method, |m| m["method"] == method).await;
        if let Some(live) = request.get("id") {
            self.live_ids.insert(id.to_string(), live.clone());
        }
        let (live, recorded) = (comparable(&request["params"]), comparable(&message["params"]));
        let mut differing: Vec<&String> = live.keys().chain(recorded.keys()).collect();
        differing.retain(|key| live.get(*key) != recorded.get(*key));
        let mut seen = HashSet::new();
        differing.retain(|key| seen.insert(key.to_string()));
        if !differing.is_empty() {
            let keys: Vec<String> = differing.iter().map(|key| key.to_string()).collect();
            self.mismatches.push(format!("{method}: {}", keys.join(",")));
        }
    }

    async fn server_line(&mut self, message: &Value) {
        let response = message.get("method").is_none();
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        if response && self.skipped.contains(&id.to_string()) {
            return;
        }
        let mut message = message.clone();
        if response {
            message["id"] = self.live_ids.get(&id.to_string()).cloned().unwrap_or(Value::Null);
        }
        let stdout = self.server.lock().as_ref().map(|server| server.stdout.clone());
        let Some(stdout) = stdout else { return };
        if let Some(stdout) = stdout.lock().await.as_mut() {
            let line = format!("{message}\n");
            stdout.write_all(line.as_bytes()).await.expect("write stdout");
        }
    }

    async fn run(mut self) -> (Vec<Value>, Vec<String>) {
        for entry in read_wire(&self.scenario) {
            match entry.from.as_str() {
                "runtime" => self.runtime(&entry.message).await,
                "client" => self.client(&entry.message).await,
                _ => self.server_line(&entry.message).await,
            }
            settle().await;
        }
        self.close().await;
        if let Some(failure) = self.failures.lock().first() {
            panic!("{}: {failure}", self.scenario);
        }
        let events = self.events.lock().clone();
        (events, self.mismatches)
    }
}

async fn replay_codex_recording(scenario: &str) -> Option<String> {
    let (events, mismatches) = Replay::new(scenario).run().await;
    let expected = intern_ids(&kept(read_original_events(scenario)), false);
    let diff = first_difference(&intern_ids(&events, false), &expected);
    let mismatched = (!mismatches.is_empty()).then(|| format!("wire: {}", mismatches.join("; ")));
    match (diff, mismatched) {
        (None, None) => None,
        (diff, wire) => Some([diff, wire].into_iter().flatten().collect::<Vec<_>>().join(" | ")),
    }
}

async fn assert_replays(scenario: &str) {
    assert!(SCENARIOS.contains(&scenario));
    if let Some(diff) = replay_codex_recording(scenario).await {
        panic!("{scenario}: {diff}");
    }
}

macro_rules! scenarios {
    ($($name:ident => $scenario:literal),* $(,)?) => {
        $(
            #[tokio::test(flavor = "current_thread")]
            async fn $name() {
                assert_replays($scenario).await;
            }
        )*
    };
}

scenarios! {
    turn_tools_matches_the_original_pipeline => "turn-tools",
    steer_matches_the_original_pipeline => "steer",
    stop_interrupt_matches_the_original_pipeline => "stop-interrupt",
    approval_allow_matches_the_original_pipeline => "approval-allow",
    approval_deny_matches_the_original_pipeline => "approval-deny",
    subagent_matches_the_original_pipeline => "subagent",
    resume_matches_the_original_pipeline => "resume",
    web_search_matches_the_original_pipeline => "web-search",
    plan_mode_matches_the_original_pipeline => "plan-mode",
    user_question_matches_the_original_pipeline => "user-question",
    auth_failure_matches_the_original_pipeline => "auth-failure",
}
