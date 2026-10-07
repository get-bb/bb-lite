use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use async_trait::async_trait;
use bb_core::env::{AgentEnvArgs, build_agent_env, login_shell_path, node_platform};
use bb_core::exec::KeyedLock;
use bb_core::ids::random_hex;
use bb_core::{
    Delivered, ExecutionOptions, PermissionEscalation, ProviderId, ProviderModels, ProviderStatus,
    RunnerError, RunnerErrorCode, RunnerEventBody, RunnerInfo, RunnerResult, RunnerSnapshot,
    SERVER_URL_PLACEHOLDER, SessionSnapshot, SubmitTurnArgs, SubmitTurnMode, SubmitTurnResult,
    ToolCallResponse,
};
use bb_provider::{
    ApprovalEnforcer, EventBuilder, ExitInfo, Interaction, ProviderAdapter, ProviderSession,
    SessionHost, SessionHostCallbacks, SteerInput, SteerOutcome, ToolCall, TurnInput,
};
use bb_remote::outbox::Outbox;
use futures::future::{BoxFuture, FutureExt, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::time::Instant;

pub const SESSION_METHODS: [&str; 12] = [
    "describe",
    "snapshot",
    "ackEvents",
    "listProviders",
    "listModels",
    "submitTurn",
    "interruptTurn",
    "releaseSession",
    "resolveInteraction",
    "resolveToolCall",
    "renameSession",
    "deleteThreadStorage",
];

const MAX_REMEMBERED_REQUESTS: usize = 32;
const POLL: Duration = Duration::from_millis(20);

#[derive(Clone, Copy, Debug)]
pub struct SessionTiming {
    pub turn_start_timeout: Duration,
    pub watchdog_interval: Duration,
    pub interrupt_timeout: Duration,
    pub idle_reap: Duration,
}

impl Default for SessionTiming {
    fn default() -> Self {
        Self {
            turn_start_timeout: Duration::from_millis(120_000),
            watchdog_interval: Duration::from_millis(15_000),
            interrupt_timeout: Duration::from_millis(5_000),
            idle_reap: Duration::from_millis(30 * 60_000),
        }
    }
}

pub type TerminalIds = Arc<dyn Fn() -> Vec<String> + Send + Sync>;
pub type LoginPath = Arc<dyn Fn() -> BoxFuture<'static, Option<String>> + Send + Sync>;

pub struct SessionManagerOptions {
    pub data_dir: PathBuf,
    pub server_url: String,
    pub bb_cli_path: String,
    pub outbox: Arc<Outbox>,
    pub adapters: Vec<Arc<dyn ProviderAdapter>>,
    pub terminal_ids: Option<TerminalIds>,
    /// Defaults to `bb_core::env::login_shell_path`.
    pub login_path: Option<LoginPath>,
    pub timing: SessionTiming,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AckEventsArgs {
    pub seq: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListModelsArgs {
    pub provider_id: ProviderId,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadArgs {
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveInteractionArgs {
    pub thread_id: String,
    pub request_id: String,
    pub resolution: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveToolCallArgs {
    pub thread_id: String,
    pub request_id: String,
    pub result: ToolCallResponse,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionArgs {
    pub thread_id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Interrupted {
    pub interrupted: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RequestKind {
    Interaction,
    ToolCall,
}

struct PendingRequest {
    kind: RequestKind,
    turn_id: Option<String>,
    reply: oneshot::Sender<RunnerResult<Value>>,
}

struct PendingStart {
    since: Instant,
    warned: bool,
}

struct LiveState {
    options: ExecutionOptions,
    pending_start: Option<PendingStart>,
    last_active_at: Instant,
    closing: bool,
    detached: bool,
    requests: IndexMap<String, PendingRequest>,
}

struct Live {
    thread_id: String,
    adapter: Arc<dyn ProviderAdapter>,
    provider: Arc<dyn ProviderSession>,
    events: Arc<EventBuilder>,
    env_key: String,
    state: Mutex<LiveState>,
}

impl Live {
    fn is_busy(&self) -> bool {
        self.events.active_turn_id().is_some() || self.state.lock().pending_start.is_some()
    }

    fn closing(&self) -> bool {
        self.state.lock().closing
    }
}

type SubmitFuture = Shared<BoxFuture<'static, RunnerResult<SubmitTurnResult>>>;
type LiveSlot = Arc<OnceLock<Weak<Live>>>;

struct Inner {
    options: SessionManagerOptions,
    timing: SessionTiming,
    instance_id: String,
    storage_root: PathBuf,
    sessions: Mutex<IndexMap<String, Arc<Live>>>,
    serialize: KeyedLock,
    remembered: Mutex<HashMap<String, IndexMap<String, SubmitFuture>>>,
    request_counter: AtomicU64,
    watchdog: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// The session half of the runner interface. Must be created inside a tokio runtime.
pub struct SessionManager {
    inner: Arc<Inner>,
}

fn uuid_v4() -> String {
    let hex = random_hex(16);
    let variant = ["8", "9", "a", "b"][usize::from(hex.as_bytes()[16] % 4)];
    format!(
        "{}-{}-4{}-{}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        variant,
        &hex[17..20],
        &hex[20..32]
    )
}

fn host_name() -> String {
    let mut buffer = [0u8; 256];
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if result != 0 {
        return String::new();
    }
    let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

fn thread_scope() -> Value {
    json!({ "kind": "thread" })
}

fn turn_scope(turn_id: &str) -> Value {
    json!({ "kind": "turn", "turnId": turn_id })
}

fn valid_thread_id(thread_id: &str) -> bool {
    !thread_id.is_empty()
        && thread_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn same_adapter(a: &Arc<dyn ProviderAdapter>, b: &Arc<dyn ProviderAdapter>) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b))
}

async fn wait_for(condition: impl Fn() -> bool, deadline: Instant) -> bool {
    while !condition() && Instant::now() < deadline {
        tokio::time::sleep(POLL).await;
    }
    condition()
}

fn to_value<T: Serialize>(value: RunnerResult<T>) -> RunnerResult<Value> {
    value.and_then(|v| serde_json::to_value(v).map_err(RunnerError::from))
}

fn parse<T: serde::de::DeserializeOwned>(params: Value) -> RunnerResult<T> {
    serde_json::from_value(params).map_err(RunnerError::from)
}

impl Inner {
    fn adapter_for(&self, provider_id: ProviderId) -> RunnerResult<Arc<dyn ProviderAdapter>> {
        let found = self.options.adapters.iter().find(|a| a.id() == provider_id);
        found.cloned().ok_or_else(|| {
            let message =
                format!("Provider \"{}\" is not available on this runner", provider_id.as_str());
            RunnerError::new(RunnerErrorCode::Unavailable, message)
        })
    }

    fn live(&self, thread_id: &str) -> Option<Arc<Live>> {
        self.sessions.lock().get(thread_id).cloned()
    }

    fn cancel_requests(&self, live: &Live, reason: &str, turn_id: Option<&str>) {
        let cancelled: Vec<(String, PendingRequest)> = {
            let mut state = live.state.lock();
            let ids: Vec<String> = state
                .requests
                .iter()
                .filter(|(_, p)| turn_id.is_none() || p.turn_id.as_deref() == turn_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| state.requests.shift_remove(&id).map(|p| (id, p)))
                .collect()
        };
        let thread_id = live.thread_id.clone();
        for (request_id, pending) in cancelled {
            let body = match pending.kind {
                RequestKind::ToolCall => {
                    RunnerEventBody::ToolCallCancelled { thread_id: thread_id.clone(), request_id }
                }
                RequestKind::Interaction => RunnerEventBody::InteractionCancelled {
                    thread_id: thread_id.clone(),
                    request_id,
                    reason: reason.to_owned(),
                },
            };
            self.options.outbox.emit(body);
            let error = RunnerError::failed(format!("Request cancelled: {reason}"));
            let _ = pending.reply.send(Err(error));
        }
    }

    fn on_event(&self, live: &Live, event: Value) {
        live.state.lock().last_active_at = Instant::now();
        let kind = event.pointer("/scope/kind").and_then(Value::as_str) == Some("turn");
        let event_type = event.get("type").and_then(Value::as_str).map(str::to_owned);
        let turn_id = event.pointer("/scope/turnId").and_then(Value::as_str).map(str::to_owned);
        let parent =
            event.get("parentToolCallId").is_some_and(|p| !p.is_null() && p.as_str() != Some(""));
        self.options.outbox.thread_event(&live.thread_id, event);
        if !kind {
            return;
        }
        match event_type.as_deref() {
            Some("turn/completed") => {
                self.cancel_requests(live, "turn_completed", turn_id.as_deref())
            }
            Some("turn/started") if !parent => live.state.lock().pending_start = None,
            _ => {}
        }
    }

    fn system_error(&self, live: &Live, turn_id: Option<&str>, report: Value) {
        live.events.flush();
        let scope = turn_id.map_or_else(thread_scope, turn_scope);
        let mut event = json!({ "type": "system/error", "scope": scope });
        if let (Some(target), Value::Object(fields)) = (event.as_object_mut(), report) {
            target.extend(fields);
        }
        self.options.outbox.thread_event(&live.thread_id, event);
    }

    fn on_provider_exit(self: &Arc<Self>, live: Arc<Live>, info: ExitInfo) {
        if live.closing() {
            return;
        }
        let turn_id = live.events.active_turn_id();
        let was_busy = live.is_busy();
        let message = format!(
            "Provider \"{}\" exited unexpectedly: {}",
            live.adapter.id().as_str(),
            info.message
        );
        live.events.settle("failed", Some(&message));
        let chars: Vec<char> = info.stderr_tail.chars().collect();
        let stderr: String = chars[chars.len().saturating_sub(4000)..].iter().collect();
        let mut report = json!({ "code": "provider_process_exited", "message": message });
        if !stderr.is_empty() {
            report["detail"] = Value::String(format!("stderr:\n{stderr}"));
        }
        if was_busy {
            self.system_error(&live, turn_id.as_deref(), report);
        }
        let this = self.clone();
        tokio::spawn(async move { this.close_session(&live, "provider_exited").await });
    }

    async fn close_session(&self, live: &Arc<Live>, reason: &str) {
        {
            let mut state = live.state.lock();
            if state.closing {
                return;
            }
            state.closing = true;
        }
        {
            let mut sessions = self.sessions.lock();
            if sessions.get(&live.thread_id).is_some_and(|s| Arc::ptr_eq(s, live)) {
                sessions.shift_remove(&live.thread_id);
            }
        }
        let _ = live.provider.close().await;
        live.events.flush();
        live.state.lock().detached = true;
        self.cancel_requests(live, reason, None);
    }

    async fn request(
        &self,
        live: Option<Arc<Live>>,
        kind: RequestKind,
        turn_id: Option<String>,
        announce: impl FnOnce(&Live, String) -> RunnerEventBody,
    ) -> RunnerResult<Value> {
        let Some(live) = live.filter(|l| !l.closing()) else {
            return Err(RunnerError::failed("Provider session is not open"));
        };
        let count = self.request_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let request_id = format!("{}:{count}", self.instance_id);
        live.events.flush();
        let (reply, answer) = oneshot::channel();
        let pending = PendingRequest { kind, turn_id, reply };
        live.state.lock().requests.insert(request_id.clone(), pending);
        self.options.outbox.emit(announce(&live, request_id));
        drop(live);
        answer.await.unwrap_or_else(|_| Err(RunnerError::failed("Provider session is not open")))
    }

    fn deliver(&self, thread_id: &str, request_id: &str, value: Value) -> Delivered {
        let pending =
            self.live(thread_id).and_then(|l| l.state.lock().requests.shift_remove(request_id));
        let delivered = pending.is_some();
        if let Some(pending) = pending {
            let _ = pending.reply.send(Ok(value));
        }
        Delivered { delivered }
    }

    async fn open_session(
        self: &Arc<Self>,
        args: &SubmitTurnArgs,
        previous: Option<Arc<Live>>,
    ) -> RunnerResult<Arc<Live>> {
        let spec = &args.session;
        let execution = &args.options;
        let thread_id = spec.thread_id.clone();
        let adapter = self.adapter_for(spec.provider_id)?;
        let storage_dir = self.storage_root.join(&thread_id);
        tokio::fs::create_dir_all(&storage_dir).await?;
        let storage_dir = storage_dir.to_string_lossy().into_owned();
        let login_path = match &self.options.login_path {
            Some(resolve) => resolve().await,
            None => login_shell_path().await,
        };
        let env = build_agent_env(AgentEnvArgs {
            login_path: login_path.as_deref(),
            bb_cli_path: &self.options.bb_cli_path,
            server_url: &self.options.server_url,
            thread_storage_dir: &storage_dir,
            spec_env: &spec.env,
            base_env: None,
        });
        let env_key = serde_json::to_string(&env.agent)?;
        if let Some(previous) = &previous {
            let same_setup =
                same_adapter(&previous.adapter, &adapter) && previous.env_key == env_key;
            if same_setup && previous.provider.can_apply(spec, execution) {
                previous.state.lock().options = execution.clone();
                return Ok(previous.clone());
            }
            self.close_session(previous, "session_rebuilt").await;
        }
        let slot: LiveSlot = Arc::new(OnceLock::new());
        let weak = Arc::downgrade(self);
        let emit_slot = slot.clone();
        let emit_thread = thread_id.clone();
        let events = Arc::new(EventBuilder::new(Arc::new(move |event: Value| {
            let Some(inner) = weak.upgrade() else { return };
            match emit_slot.get() {
                None => inner.options.outbox.thread_event(&emit_thread, event),
                Some(live) => {
                    if let Some(live) = live.upgrade().filter(|l| !l.state.lock().detached) {
                        inner.on_event(&live, event);
                    }
                }
            }
        })));
        let callbacks = Arc::new(Callbacks {
            inner: Arc::downgrade(self),
            slot: slot.clone(),
            adapter: adapter.clone(),
            thread_id: thread_id.clone(),
        });
        let host = SessionHost {
            events: events.clone(),
            env: env.agent,
            process_env: env.process,
            thread_storage_dir: storage_dir,
            writable_roots: vec![self.storage_root.to_string_lossy().into_owned()],
            callbacks,
        };
        let known = previous.map(|p| p.provider.provider_thread_id());
        let mut resumable = spec.clone();
        resumable.provider_thread_id = spec.provider_thread_id.clone().or(known);
        let provider = adapter.open(resumable, execution.clone(), host).await?;
        let live = Arc::new(Live {
            thread_id: thread_id.clone(),
            adapter,
            provider,
            events,
            env_key,
            state: Mutex::new(LiveState {
                options: execution.clone(),
                pending_start: None,
                last_active_at: Instant::now(),
                closing: false,
                detached: false,
                requests: IndexMap::new(),
            }),
        });
        let _ = slot.set(Arc::downgrade(&live));
        self.sessions.lock().insert(thread_id.clone(), live.clone());
        live.events.flush();
        let resolved = json!({
            "type": "provider.env-resolved",
            "providerThreadId": live.provider.provider_thread_id(),
            "entries": env.entries,
            "scope": thread_scope(),
        });
        self.options.outbox.thread_event(&thread_id, resolved);
        Ok(live)
    }

    async fn start_turn(self: &Arc<Self>, args: &SubmitTurnArgs) -> RunnerResult<SubmitTurnResult> {
        let live = self.open_session(args, self.live(&args.session.thread_id)).await?;
        {
            let mut state = live.state.lock();
            state.pending_start = Some(PendingStart { since: Instant::now(), warned: false });
            state.last_active_at = Instant::now();
        }
        let input = TurnInput {
            client_request_id: args.client_request_id.clone(),
            input: args.input.clone(),
            options: args.options.clone(),
        };
        if let Err(error) = live.provider.start_turn(input).await {
            live.state.lock().pending_start = None;
            return Err(error);
        }
        Ok(SubmitTurnResult::Started { provider_thread_id: live.provider.provider_thread_id() })
    }

    async fn submit(self: &Arc<Self>, args: SubmitTurnArgs) -> RunnerResult<SubmitTurnResult> {
        let live = self.live(&args.session.thread_id);
        if args.mode == SubmitTurnMode::Start {
            if live.as_ref().is_none_or(|l| !l.is_busy()) {
                return self.start_turn(&args).await;
            }
            return Err(RunnerError::new(
                RunnerErrorCode::CompetingTurn,
                "A turn is already running",
            ));
        }
        if let Some(live) = &live {
            let starting = live.state.lock().pending_start.is_some();
            if args.mode == SubmitTurnMode::Auto && starting {
                let deadline = Instant::now() + self.timing.interrupt_timeout;
                let settled = || {
                    let state = live.state.lock();
                    state.pending_start.is_none() || state.closing
                };
                wait_for(settled, deadline).await;
            }
        }
        let active_turn_id =
            live.as_ref().filter(|l| !l.closing()).and_then(|l| l.events.active_turn_id());
        let turn_id = match &args.mode {
            SubmitTurnMode::Steer { expected_turn_id } => Some(expected_turn_id.clone()),
            _ => active_turn_id.clone(),
        };
        let steerable =
            live.as_ref().zip(turn_id).filter(|(_, id)| active_turn_id.as_ref() == Some(id));
        if let Some((live, turn_id)) = steerable {
            let steering = SteerInput {
                client_request_id: args.client_request_id.clone(),
                input: args.input.clone(),
                options: args.options.clone(),
                expected_turn_id: turn_id.clone(),
            };
            if live.provider.steer(steering).await? == SteerOutcome::Steered {
                let provider_thread_id = live.provider.provider_thread_id();
                return Ok(SubmitTurnResult::Steered { provider_thread_id, turn_id });
            }
        }
        if matches!(args.mode, SubmitTurnMode::Steer { .. }) {
            let message = "The expected turn is no longer active";
            return Err(RunnerError::new(RunnerErrorCode::StaleTurn, message));
        }
        if live.as_ref().is_some_and(|l| !l.closing() && l.is_busy()) {
            let message = "A turn is already starting";
            return Err(RunnerError::new(RunnerErrorCode::CompetingTurn, message));
        }
        self.start_turn(&args).await
    }

    async fn remember(self: &Arc<Self>, args: SubmitTurnArgs) -> RunnerResult<SubmitTurnResult> {
        let thread_id = args.session.thread_id.clone();
        let request_id = args.client_request_id.clone();
        let future = {
            let mut remembered = self.remembered.lock();
            let by_request = remembered.entry(thread_id.clone()).or_default();
            if let Some(known) = by_request.get(&request_id) {
                known.clone()
            } else {
                let this = self.clone();
                let key = request_id.clone();
                let work = async move {
                    let result = this.serialize.run(&thread_id, this.submit(args)).await;
                    if result.is_err() {
                        let mut remembered = this.remembered.lock();
                        if let Some(by_request) = remembered.get_mut(&thread_id) {
                            by_request.shift_remove(&request_id);
                        }
                    }
                    result
                };
                let shared = work.boxed().shared();
                by_request.insert(key, shared.clone());
                if by_request.len() > MAX_REMEMBERED_REQUESTS {
                    by_request.shift_remove_index(0);
                }
                tokio::spawn(shared.clone());
                shared
            }
        };
        future.await
    }

    async fn interrupt(self: &Arc<Self>, thread_id: &str) -> Interrupted {
        let Some(live) = self.live(thread_id).filter(|l| l.is_busy()) else {
            return Interrupted { interrupted: false };
        };
        let deadline = Instant::now() + self.timing.interrupt_timeout;
        let provider = live.provider.clone();
        tokio::spawn(async move {
            let _ = provider.interrupt().await;
        });
        wait_for(|| live.closing() || !live.is_busy(), deadline).await;
        live.events.settle("interrupted", None);
        self.close_session(&live, "interrupted").await;
        Interrupted { interrupted: true }
    }

    fn watch(self: &Arc<Self>) {
        let now = Instant::now();
        let sessions: Vec<Arc<Live>> = self.sessions.lock().values().cloned().collect();
        let limit = self.timing.turn_start_timeout;
        for live in sessions {
            let timed_out = {
                let mut state = live.state.lock();
                match state.pending_start.as_mut() {
                    Some(start) if !start.warned && now - start.since >= limit => {
                        start.warned = true;
                        true
                    }
                    _ => false,
                }
            };
            if timed_out {
                let seconds = (limit.as_millis() as f64 / 1000.0).round();
                let message = format!(
                    "The provider accepted a turn but did not start it within {seconds}s. The request may be stalled; stopping the thread interrupts it."
                );
                let report = json!({ "code": "provider_turn_start_timeout", "message": message });
                self.system_error(&live, None, report);
            }
            let (quiet, has_requests) = {
                let state = live.state.lock();
                (now - state.last_active_at >= self.timing.idle_reap, !state.requests.is_empty())
            };
            let waiting = has_requests || live.is_busy();
            if !quiet || waiting || live.events.has_open_background_work() {
                continue;
            }
            let this = self.clone();
            tokio::spawn(async move {
                let key = live.thread_id.clone();
                let reap = async {
                    if !live.is_busy() {
                        this.close_session(&live, "idle").await;
                    }
                };
                this.serialize.run(&key, reap).await;
            });
        }
    }
}

struct Callbacks {
    inner: Weak<Inner>,
    slot: LiveSlot,
    adapter: Arc<dyn ProviderAdapter>,
    thread_id: String,
}

impl Callbacks {
    fn parts(&self) -> RunnerResult<(Arc<Inner>, Option<Arc<Live>>)> {
        let inner = self.inner.upgrade();
        let inner = inner.ok_or_else(|| RunnerError::failed("Provider session is not open"))?;
        Ok((inner, self.slot.get().and_then(Weak::upgrade)))
    }
}

#[async_trait]
impl SessionHostCallbacks for Callbacks {
    async fn call_tool(&self, call: ToolCall) -> RunnerResult<ToolCallResponse> {
        let (inner, live) = self.parts()?;
        let thread_id = self.thread_id.clone();
        let turn_id = call.turn_id.clone();
        let announce = move |_: &Live, request_id: String| RunnerEventBody::ToolCallRequested {
            thread_id,
            turn_id: call.turn_id,
            request_id,
            call_id: call.call_id,
            tool: call.tool,
            arguments: call.arguments,
        };
        let answer = inner.request(live, RequestKind::ToolCall, turn_id, announce).await?;
        parse(answer)
    }

    async fn request_interaction(&self, interaction: Interaction) -> RunnerResult<Value> {
        let (inner, live) = self.parts()?;
        let unattended = live.as_ref().is_some_and(|l| {
            l.state.lock().options.permission_escalation == PermissionEscalation::Deny
        });
        let enforced = self.adapter.approval_enforced_by() == ApprovalEnforcer::Runner;
        let approval = interaction.payload.get("kind").and_then(Value::as_str) == Some("approval");
        if unattended && enforced && approval {
            return Ok(json!({ "decision": "deny" }));
        }
        let thread_id = self.thread_id.clone();
        let provider_id = self.adapter.id();
        let turn_id = interaction.turn_id.clone();
        let announce =
            move |session: &Live, request_id: String| RunnerEventBody::InteractionRequested {
                thread_id,
                turn_id: interaction.turn_id,
                request_id,
                provider_id,
                provider_thread_id: session.provider.provider_thread_id(),
                payload: interaction.payload,
            };
        inner.request(live, RequestKind::Interaction, turn_id, announce).await
    }

    fn on_exit(&self, info: ExitInfo) {
        if let (Some(inner), Some(live)) =
            (self.inner.upgrade(), self.slot.get().and_then(Weak::upgrade))
        {
            inner.on_provider_exit(live, info);
        }
    }
}

impl SessionManager {
    pub fn new(options: SessionManagerOptions) -> Self {
        let storage_root = options.data_dir.join("thread-storage");
        let timing = options.timing;
        let inner = Arc::new(Inner {
            options,
            timing,
            instance_id: uuid_v4(),
            storage_root,
            sessions: Mutex::new(IndexMap::new()),
            serialize: KeyedLock::new(),
            remembered: Mutex::new(HashMap::new()),
            request_counter: AtomicU64::new(0),
            watchdog: Mutex::new(None),
        });
        let weak = Arc::downgrade(&inner);
        let watchdog = tokio::spawn(async move {
            let mut interval = tokio::time::interval(timing.watchdog_interval);
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(inner) = weak.upgrade() else { return };
                inner.watch();
            }
        });
        *inner.watchdog.lock() = Some(watchdog);
        Self { inner }
    }

    pub fn instance_id(&self) -> &str {
        &self.inner.instance_id
    }

    pub async fn describe(&self) -> RunnerResult<RunnerInfo> {
        let platform = if node_platform() == "darwin" { "darwin" } else { "linux" };
        Ok(RunnerInfo {
            instance_id: self.inner.instance_id.clone(),
            version: "0.0.1".into(),
            host_name: host_name(),
            platform: platform.into(),
            home_dir: std::env::var("HOME").unwrap_or_default(),
            data_dir: self.inner.options.data_dir.to_string_lossy().into_owned(),
            thread_storage_root: self.inner.storage_root.to_string_lossy().into_owned(),
        })
    }

    pub async fn snapshot(&self) -> RunnerResult<RunnerSnapshot> {
        let inner = &self.inner;
        inner.options.outbox.flush();
        let live: Vec<Arc<Live>> = inner.sessions.lock().values().cloned().collect();
        let sessions = live
            .iter()
            .map(|s| SessionSnapshot {
                thread_id: s.thread_id.clone(),
                provider_id: s.adapter.id(),
                provider_thread_id: s.provider.provider_thread_id(),
                active_turn_id: s.events.active_turn_id(),
            })
            .collect();
        let pending_request_ids =
            live.iter().flat_map(|s| s.state.lock().requests.keys().cloned().collect::<Vec<_>>());
        Ok(RunnerSnapshot {
            sessions,
            pending_request_ids: pending_request_ids.collect(),
            terminal_ids: inner.options.terminal_ids.as_ref().map(|ids| ids()).unwrap_or_default(),
            last_event_seq: inner.options.outbox.last_seq(),
        })
    }

    pub async fn ack_events(&self, args: AckEventsArgs) -> RunnerResult<()> {
        self.inner.options.outbox.ack(args.seq);
        Ok(())
    }

    pub async fn list_providers(&self) -> RunnerResult<Vec<ProviderStatus>> {
        let statuses = self.inner.options.adapters.iter().map(|a| a.status());
        futures::future::try_join_all(statuses).await
    }

    pub async fn list_models(&self, args: ListModelsArgs) -> RunnerResult<ProviderModels> {
        let adapter = self.inner.adapter_for(args.provider_id)?;
        adapter.list_models(args.cwd.as_deref()).await
    }

    pub async fn submit_turn(&self, mut args: SubmitTurnArgs) -> RunnerResult<SubmitTurnResult> {
        let server_url = &self.inner.options.server_url;
        for value in args.session.env.values_mut() {
            *value = value.replace(SERVER_URL_PLACEHOLDER, server_url);
        }
        self.inner.remember(args).await
    }

    pub async fn interrupt_turn(&self, args: ThreadArgs) -> RunnerResult<Interrupted> {
        let inner = &self.inner;
        Ok(inner.serialize.run(&args.thread_id, inner.interrupt(&args.thread_id)).await)
    }

    pub async fn release_session(&self, args: ThreadArgs) -> RunnerResult<()> {
        let inner = &self.inner;
        let release = async {
            if let Some(live) = inner.live(&args.thread_id).filter(|l| !l.is_busy()) {
                inner.close_session(&live, "released").await;
            }
        };
        inner.serialize.run(&args.thread_id, release).await;
        Ok(())
    }

    pub async fn resolve_interaction(
        &self,
        args: ResolveInteractionArgs,
    ) -> RunnerResult<Delivered> {
        Ok(self.inner.deliver(&args.thread_id, &args.request_id, args.resolution))
    }

    pub async fn resolve_tool_call(&self, args: ResolveToolCallArgs) -> RunnerResult<Delivered> {
        let result = serde_json::to_value(args.result)?;
        Ok(self.inner.deliver(&args.thread_id, &args.request_id, result))
    }

    pub async fn rename_session(&self, args: RenameSessionArgs) -> RunnerResult<()> {
        match self.inner.live(&args.thread_id) {
            Some(live) if live.provider.supports_rename() => {
                live.provider.rename(&args.title).await
            }
            _ => Ok(()),
        }
    }

    pub async fn delete_thread_storage(&self, args: ThreadArgs) -> RunnerResult<()> {
        let inner = &self.inner;
        let thread_id = args.thread_id;
        let work = async {
            if !valid_thread_id(&thread_id) {
                return Err(RunnerError::new(RunnerErrorCode::InvalidPath, "Invalid thread id"));
            }
            inner.interrupt(&thread_id).await;
            if let Some(live) = inner.live(&thread_id) {
                inner.close_session(&live, "deleted").await;
            }
            inner.remembered.lock().remove(&thread_id);
            match tokio::fs::remove_dir_all(inner.storage_root.join(&thread_id)).await {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
                _ => Ok(()),
            }
        };
        inner.serialize.run(&thread_id, work).await
    }

    pub async fn shutdown(&self) {
        let inner = &self.inner;
        if let Some(watchdog) = inner.watchdog.lock().take() {
            watchdog.abort();
        }
        let live: Vec<Arc<Live>> = inner.sessions.lock().values().cloned().collect();
        let closes = live.iter().map(|s| inner.close_session(s, "shutdown"));
        futures::future::join_all(closes).await;
        inner.options.outbox.flush();
    }

    /// Runs one session method from its JSON parameters; `None` when `method` is not one.
    pub async fn call(&self, method: &str, params: Value) -> Option<RunnerResult<Value>> {
        let unit = |r: RunnerResult<()>| r.map(|()| Value::Null);
        Some(match method {
            "describe" => to_value(self.describe().await),
            "snapshot" => to_value(self.snapshot().await),
            "ackEvents" => match parse(params) {
                Ok(args) => unit(self.ack_events(args).await),
                Err(error) => Err(error),
            },
            "listProviders" => to_value(self.list_providers().await),
            "listModels" => to_value(async { self.list_models(parse(params)?).await }.await),
            "submitTurn" => to_value(async { self.submit_turn(parse(params)?).await }.await),
            "interruptTurn" => to_value(async { self.interrupt_turn(parse(params)?).await }.await),
            "releaseSession" => unit(async { self.release_session(parse(params)?).await }.await),
            "resolveInteraction" => {
                to_value(async { self.resolve_interaction(parse(params)?).await }.await)
            }
            "resolveToolCall" => {
                to_value(async { self.resolve_tool_call(parse(params)?).await }.await)
            }
            "renameSession" => unit(async { self.rename_session(parse(params)?).await }.await),
            "deleteThreadStorage" => {
                unit(async { self.delete_thread_storage(parse(params)?).await }.await)
            }
            _ => return None,
        })
    }
}

impl Drop for SessionManager {
    fn drop(&mut self) {
        if let Some(watchdog) = self.inner.watchdog.lock().take() {
            watchdog.abort();
        }
    }
}
