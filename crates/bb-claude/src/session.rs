use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, OnceLock, Weak};
use std::time::Duration;

use async_trait::async_trait;
use bb_core::env::{ChildEnv, EnvMap, login_shell_env};
use bb_core::{
    ExecutionOptions, PermissionEscalation, ProviderAuth, ProviderId, ProviderModels,
    ProviderStatus, RunnerError, RunnerErrorCode, RunnerResult, SessionSpec,
};
use bb_provider::{
    ApprovalEnforcer, ExitInfo as HostExit, Interaction, ProviderAdapter, ProviderSession,
    SessionHost, SteerInput, SteerOutcome, ToolCall, TurnInput,
};
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::interactions::{ClaudePermissions, PermissionHost};
use crate::options::{
    self, ClaudePermissionMode, ClaudeSettings, LaunchContext, LaunchHost, SessionStart, ToolCaller,
};
use crate::protocol::{
    CanUseToolRequest, ClaudeChild, ClaudeClient, ClaudeHandlers, ClientOptions, ExitInfo,
    InitializeParams, PermissionDecision, spawn_claude,
};
use crate::tools::ToolContext;
use crate::translate::ClaudeTranslator;

pub const MISSING_CLI: &str = "bb could not find the Claude Code CLI on this machine. Install Claude Code (https://claude.com/claude-code), or set BB_CLAUDE_CODE_EXECUTABLE to the full path of the claude binary, then restart bb.";
pub const STOPPED: &str = "Thread stopped while awaiting permission approval";
pub const ENDED: &str = "Claude Code ended its session";
pub const CLOSED: &str = "Claude SDK input stream is closed";
pub const SUBAGENTS_OFF: &str =
    "bb has disabled Claude Code native subagents; use bb delegation instead.";
pub const WORKFLOWS_OFF: &str = "bb has disabled the Claude Code Workflow tool.";
pub const CLOSE_TIMEOUT: Duration = Duration::from_millis(4_000);
const UNAUTHORIZED: [&str; 2] = ["authentication_failed", "oauth_org_not_allowed"];
const STATUS_TIMEOUT: Duration = Duration::from_millis(10_000);
const STDERR_TAIL_CHARS: usize = 4_000;
static MISSING_BINARY: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new("Native CLI binary for .+ not found").ok());

/// `(executable, args, cwd, env)`: launches the CLI. Replaces `spawn_claude` in tests.
pub type SpawnClaude = Arc<dyn Fn(&str, &[String], &str, &EnvMap) -> ClaudeChild + Send + Sync>;

/// Makes the `--session-id` of a new session. Defaults to `random_uuid`.
pub type NewSessionId = Arc<dyn Fn() -> String + Send + Sync>;

/// The TypeScript `ClaudeAdapterOptions`: `spawn` is the `query` seam; `executable` skips
/// resolving the `claude` binary; `session_id` replaces `randomUUID()` for new sessions.
#[derive(Clone, Default)]
pub struct ClaudeAdapterOptions {
    pub spawn: Option<SpawnClaude>,
    pub executable: Option<String>,
    pub session_id: Option<NewSessionId>,
}

fn describe(message: &str) -> String {
    match MISSING_BINARY.as_ref() {
        Some(pattern) if pattern.is_match(message) => MISSING_CLI.to_owned(),
        _ => message.to_owned(),
    }
}

fn launch_error(message: &str) -> RunnerError {
    let message = describe(message);
    let code = if message == MISSING_CLI {
        RunnerErrorCode::MissingExecutable
    } else {
        RunnerErrorCode::Failed
    };
    RunnerError::new(code, message)
}

/// A random RFC 4122 version 4 id.
pub fn random_uuid() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let state = RandomState::new();
    let mut bytes = [0u8; 16];
    for (index, chunk) in bytes.chunks_mut(8).enumerate() {
        let seed = COUNTER.fetch_add(1, Ordering::Relaxed) ^ index as u64;
        chunk.copy_from_slice(&state.hash_one(seed).to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

fn tail(text: &str) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(STDERR_TAIL_CHARS)).collect::<String>().trim().to_owned()
}

#[derive(Clone)]
struct AdapterConfig {
    spawn: SpawnClaude,
    executable: Option<String>,
    session_id: NewSessionId,
}

impl AdapterConfig {
    async fn executable(&self, env: &EnvMap) -> RunnerResult<Option<String>> {
        match &self.executable {
            Some(path) => Ok(Some(path.clone())),
            None => options::resolve_executable(env).await,
        }
    }
}

struct State {
    settings: ClaudeSettings,
    options: ExecutionOptions,
}

type Interrupting = Shared<BoxFuture<'static, ()>>;

struct Inner {
    spec: SessionSpec,
    host: SessionHost,
    signature: String,
    state: Mutex<State>,
    translator: Mutex<ClaudeTranslator>,
    permissions: ClaudePermissions,
    client: OnceLock<ClaudeClient>,
    interrupting: Mutex<Option<Interrupting>>,
    provider_thread_id: Mutex<String>,
    ended: AtomicBool,
    closing: AtomicBool,
    rebuild: AtomicBool,
    tool_calls: AtomicU64,
}

/// One Claude Code process driven over stdio (the TypeScript `ClaudeSession`).
pub struct ClaudeSession {
    inner: Arc<Inner>,
}

fn signature_of(spec: &SessionSpec, options: &ExecutionOptions) -> String {
    let fixed = options::claude_settings(options).fixed();
    json!([spec.cwd, spec.instructions, spec.dynamic_tools, spec.skill_dirs, fixed]).to_string()
}

struct Permissions(Weak<Inner>);

#[async_trait]
impl PermissionHost for Permissions {
    async fn request_interaction(&self, interaction: Interaction) -> RunnerResult<Value> {
        let Some(inner) = self.0.upgrade() else { return Err(RunnerError::failed(ENDED)) };
        let host = inner.host.clone();
        drop(inner);
        host.request_interaction(interaction).await
    }

    fn item_id(&self, tool_use_id: &str) -> String {
        let known = self.0.upgrade().and_then(|inner| inner.host.events.bb_item_id(tool_use_id));
        known.unwrap_or_else(|| tool_use_id.to_owned())
    }

    fn turn_id(&self) -> Option<String> {
        self.0.upgrade().and_then(|inner| inner.host.events.active_turn_id())
    }

    fn mode(&self) -> ClaudePermissionMode {
        let mode = self.0.upgrade().map(|inner| inner.state.lock().settings.base_mode);
        mode.unwrap_or(ClaudePermissionMode::Default)
    }

    fn escalation(&self) -> PermissionEscalation {
        let escalation =
            self.0.upgrade().map(|inner| inner.state.lock().options.permission_escalation);
        escalation.unwrap_or(PermissionEscalation::Ask)
    }
}

struct Handlers(Weak<Inner>);

#[async_trait]
impl ClaudeHandlers for Handlers {
    fn on_message(&self, message: Value) {
        if let Some(inner) = self.0.upgrade() {
            inner.receive(&message);
        }
    }

    async fn can_use_tool(&self, request: CanUseToolRequest) -> PermissionDecision {
        let Some(inner) = self.0.upgrade() else { return PermissionDecision::deny(ENDED) };
        inner.permissions.can_use_tool(&request, CancellationToken::new()).await.into()
    }

    async fn can_use_tool_response(&self, request: CanUseToolRequest) -> Value {
        let Some(inner) = self.0.upgrade() else {
            return PermissionDecision::deny(ENDED).to_response(request.tool_use_id.as_deref());
        };
        let cancel = CancellationToken::new();
        let _guard = cancel.clone().drop_guard();
        let result = inner.permissions.can_use_tool(&request, cancel).await;
        result.to_response(request.tool_use_id.as_deref())
    }

    async fn hook_callback(
        &self,
        _callback_id: String,
        input: Value,
        _tool_use_id: Option<String>,
    ) -> Result<Value, String> {
        let Some(inner) = self.0.upgrade() else { return Ok(json!({"continue": true})) };
        Ok(inner.deny_disabled_tools(&input))
    }

    fn on_exit(&self, exit: ExitInfo) {
        if let Some(inner) = self.0.upgrade() {
            inner.on_exit(&exit);
        }
    }
}

impl Inner {
    fn closed(&self) -> bool {
        self.ended.load(Ordering::SeqCst) || self.closing.load(Ordering::SeqCst)
    }

    fn receive(&self, message: &Value) {
        let Some(kind) = message.get("type").and_then(Value::as_str) else { return };
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        let session_id = message.get("session_id").and_then(Value::as_str).map(str::trim);
        if let Some(id) = session_id.filter(|id| !id.is_empty()) {
            let changed = {
                let mut current = self.provider_thread_id.lock();
                let changed = *current != id;
                if changed {
                    id.clone_into(&mut current);
                }
                changed
            };
            if changed {
                self.host.events.identity(id);
            }
        }
        let error = message.get("error").and_then(Value::as_str).unwrap_or("");
        if kind == "assistant" && UNAUTHORIZED.contains(&error) {
            self.rebuild.store(true, Ordering::SeqCst);
        }
        self.translator.lock().handle(message);
    }

    fn deny_disabled_tools(&self, input: &Value) -> Value {
        let event = input.get("hook_event_name").and_then(Value::as_str);
        let tool = match event {
            Some("PreToolUse") => input.get("tool_name").and_then(Value::as_str).unwrap_or(""),
            _ => "",
        };
        let (subagents, workflows) = {
            let state = self.state.lock();
            (state.settings.subagents, state.settings.workflows)
        };
        let agent = tool == "Agent" || tool == "Task";
        let blocked = if agent { !subagents } else { tool == "Workflow" && !workflows };
        if !blocked {
            return json!({"continue": true});
        }
        let hook_specific_output = json!({
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": if agent { SUBAGENTS_OFF } else { WORKFLOWS_OFF },
        });
        json!({"continue": true, "hookSpecificOutput": hook_specific_output})
    }

    fn on_exit(&self, exit: &ExitInfo) {
        self.ended.store(true, Ordering::SeqCst);
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        self.permissions.cancel_pending(ENDED);
        let clean = exit.code == Some(0) && exit.error.is_none();
        let message = if clean { ENDED.to_owned() } else { describe(&exit.message()) };
        self.host.on_exit(HostExit { message, stderr_tail: tail(&exit.stderr_tail) });
    }

    fn stop(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.translator.lock().stop_tasks();
        self.permissions.cancel_pending(STOPPED);
    }

    async fn apply_settings(&self, options: &ExecutionOptions) -> Result<(), String> {
        let next = options::claude_settings(options);
        let (model, flags) = {
            let state = self.state.lock();
            (state.settings.model.clone(), state.settings.flags.to_json())
        };
        if let Some(client) = self.client.get() {
            if next.model != model {
                let wanted = (!next.model.is_empty()).then_some(next.model.as_str());
                client.set_model(wanted).await.map_err(|error| error.to_string())?;
                if !next.model.is_empty() {
                    self.translator.lock().set_model(&next.model);
                }
            }
            let next_flags = next.flags.to_json();
            if next_flags != flags {
                client.apply_flag_settings(next_flags).await.map_err(|error| error.to_string())?;
            }
        }
        self.state.lock().settings = next;
        Ok(())
    }

    async fn submit(
        &self,
        client_request_id: &str,
        input: &[Value],
        options: ExecutionOptions,
    ) -> RunnerResult<()> {
        let Some(content) = options::prompt_text(input) else {
            return Err(RunnerError::failed("Missing input"));
        };
        if self.closed() {
            return Err(RunnerError::failed(CLOSED));
        }
        self.apply_settings(&options)
            .await
            .map_err(|error| RunnerError::failed(describe(&error)))?;
        self.state.lock().options = options;
        let Some(client) = self.client.get() else { return Err(RunnerError::failed(CLOSED)) };
        let session_id = self.provider_thread_id.lock().clone();
        client
            .send_user_message(Value::String(content), &session_id, &random_uuid())
            .map_err(|_| RunnerError::failed(CLOSED))?;
        let events = &self.host.events;
        self.translator.lock().accept_input();
        events.accept_input(client_request_id, None);
        if events.active_turn_id().is_none() {
            events.open_turn(None, None);
        }
        Ok(())
    }
}

impl ClaudeSession {
    fn new(spec: SessionSpec, options: ExecutionOptions, host: SessionHost) -> Self {
        let settings = options::claude_settings(&options);
        let signature = signature_of(&spec, &options);
        let sandboxed = settings.base_mode != ClaudePermissionMode::BypassPermissions;
        let injected: HashMap<_, _> = spec
            .dynamic_tools
            .iter()
            .map(|tool| {
                let presentation =
                    tool.presentation.clone().and_then(|value| serde_json::from_value(value).ok());
                (tool.name.clone(), presentation)
            })
            .collect();
        let mut translator =
            ClaudeTranslator::new(host.events.clone(), ToolContext { injected, sandboxed });
        if !options.model.is_empty() {
            translator.set_model(&options.model);
        }
        let inner = Arc::new_cyclic(|weak: &Weak<Inner>| Inner {
            spec,
            host,
            signature,
            state: Mutex::new(State { settings, options }),
            translator: Mutex::new(translator),
            permissions: ClaudePermissions::new(Arc::new(Permissions(weak.clone()))),
            client: OnceLock::new(),
            interrupting: Mutex::new(None),
            provider_thread_id: Mutex::new(String::new()),
            ended: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            rebuild: AtomicBool::new(false),
            tool_calls: AtomicU64::new(0),
        });
        Self { inner }
    }

    fn tool_caller(&self) -> ToolCaller {
        let weak = Arc::downgrade(&self.inner);
        Arc::new(move |tool: String, arguments: Value, tool_use_id: Option<String>| {
            let weak = weak.clone();
            async move {
                let Some(inner) = weak.upgrade() else { return Err(RunnerError::failed(ENDED)) };
                let count = inner.tool_calls.fetch_add(1, Ordering::SeqCst) + 1;
                let events = &inner.host.events;
                let id = tool_use_id.filter(|id| !id.is_empty());
                let known = id.as_deref().and_then(|id| events.bb_item_id(id));
                let call_id = known.or(id).unwrap_or_else(|| format!("call-{count}"));
                let turn_id = events.active_turn_id();
                let host = inner.host.clone();
                drop(inner);
                host.call_tool(ToolCall { call_id, tool, arguments, turn_id }).await
            }
            .boxed()
        })
    }

    async fn start(self, config: &AdapterConfig) -> RunnerResult<Self> {
        let inner = &self.inner;
        let spec = &inner.spec;
        let settings = inner.state.lock().settings.clone();
        let launch_host = LaunchHost::from(&inner.host);
        let env = options::child_env(&launch_host, &settings);
        let executable = config.executable(&env).await?;
        let plugins = options::skill_plugins(&spec.skill_dirs).await;
        let is_root = unsafe { libc::getuid() } == 0;
        let session = SessionStart::for_spec(spec, (config.session_id)());
        let context = LaunchContext { executable, plugins, is_root };
        let launch = options::build_launch_with(spec, &settings, &launch_host, session, context);
        let Some(executable) = launch.executable.clone() else {
            return Err(launch_error(MISSING_CLI));
        };
        let mut client_options = ClientOptions::default();
        if !spec.dynamic_tools.is_empty() {
            let server = options::bb_tool_server(&spec.dynamic_tools, self.tool_caller());
            client_options.mcp_servers.push(Arc::new(server));
        }
        let child = (config.spawn)(&executable, &launch.args, &launch.cwd, &launch.env);
        let handlers = Arc::new(Handlers(Arc::downgrade(inner)));
        let client = ClaudeClient::with_options(child, handlers, client_options);
        tokio::spawn(client.initialize(launch.initialize));
        let _ = inner.client.set(client);
        let session_id = launch.session.id().to_owned();
        session_id.clone_into(&mut inner.provider_thread_id.lock());
        inner.host.events.identity(&session_id);
        let unknown = json!({"usedTokens": null, "modelContextWindow": null, "estimated": true});
        inner.host.events.context_window(unknown, None, false);
        Ok(self)
    }
}

#[async_trait]
impl ProviderSession for ClaudeSession {
    fn provider_thread_id(&self) -> String {
        self.inner.provider_thread_id.lock().clone()
    }

    fn can_apply(&self, spec: &SessionSpec, options: &ExecutionOptions) -> bool {
        let inner = &self.inner;
        signature_of(spec, options) == inner.signature
            && !inner.rebuild.load(Ordering::SeqCst)
            && !inner.closed()
    }

    async fn start_turn(&self, args: TurnInput) -> RunnerResult<()> {
        self.inner.submit(&args.client_request_id, &args.input, args.options).await
    }

    async fn steer(&self, args: SteerInput) -> RunnerResult<SteerOutcome> {
        let inner = &self.inner;
        let active = inner.host.events.active_turn_id().as_deref() == Some(&args.expected_turn_id);
        if !active || inner.closed() {
            return Ok(SteerOutcome::Stale);
        }
        inner.submit(&args.client_request_id, &args.input, args.options).await?;
        Ok(SteerOutcome::Steered)
    }

    async fn interrupt(&self) -> RunnerResult<()> {
        let inner = &self.inner;
        if inner.closed() {
            return Ok(());
        }
        inner.host.events.settle("interrupted", None);
        inner.stop();
        let interrupting =
            inner.client.get().map(|client| client.interrupt().map(|_| ()).boxed().shared());
        inner.interrupting.lock().clone_from(&interrupting);
        if let Some(interrupting) = interrupting {
            interrupting.await;
        }
        Ok(())
    }

    async fn close(&self) -> RunnerResult<()> {
        let inner = &self.inner;
        inner.stop();
        let Some(client) = inner.client.get() else { return Ok(()) };
        if inner.ended.load(Ordering::SeqCst) {
            return Ok(());
        }
        let pending = inner.interrupting.lock().clone();
        let interrupted =
            pending.unwrap_or_else(|| client.interrupt().map(|_| ()).boxed().shared());
        let drained = async {
            interrupted.await;
            client.end_input();
            client.wait_exit().await;
        };
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, drained).await;
        if inner.ended.load(Ordering::SeqCst) || client.is_exited() {
            return Ok(());
        }
        client.close().await;
        Ok(())
    }
}

struct ModelHandlers;

#[async_trait]
impl ClaudeHandlers for ModelHandlers {
    fn on_message(&self, _message: Value) {}

    async fn can_use_tool(&self, _request: CanUseToolRequest) -> PermissionDecision {
        PermissionDecision::deny(ENDED)
    }

    async fn hook_callback(&self, _: String, _: Value, _: Option<String>) -> Result<Value, String> {
        Ok(json!({"continue": true}))
    }

    fn on_exit(&self, _exit: ExitInfo) {}
}

async fn run_for_stdout(executable: &str, args: &[&str], env: &EnvMap) -> String {
    let mut command = tokio::process::Command::new(executable);
    command.args(args).env_clear().envs(env).kill_on_drop(true);
    command.stdin(std::process::Stdio::null());
    match tokio::time::timeout(STATUS_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        _ => String::new(),
    }
}

struct ClaudeAdapter {
    config: AdapterConfig,
    base_env: ChildEnv,
}

#[async_trait]
impl ProviderAdapter for ClaudeAdapter {
    fn id(&self) -> ProviderId {
        ProviderId::ClaudeCode
    }

    fn approval_enforced_by(&self) -> ApprovalEnforcer {
        ApprovalEnforcer::Provider
    }

    async fn status(&self) -> RunnerResult<ProviderStatus> {
        let env = (self.base_env)().await;
        let found = self.config.executable(&env).await.ok().flatten();
        let Some(executable_path) = found else {
            return Ok(ProviderStatus {
                provider_id: ProviderId::ClaudeCode,
                installed: false,
                executable_path: None,
                version: None,
                auth: ProviderAuth::Unknown,
                message: Some(MISSING_CLI.to_owned()),
            });
        };
        let version = run_for_stdout(&executable_path, &["--version"], &env).await;
        let version = version.split_whitespace().next().map(str::to_owned);
        let report = run_for_stdout(&executable_path, &["auth", "status", "--json"], &env).await;
        let report = serde_json::from_str::<Value>(&report).unwrap_or(Value::Null);
        let login = report.get("loggedIn").and_then(Value::as_bool);
        let auth = match login {
            None => ProviderAuth::Unknown,
            Some(true) => ProviderAuth::Ready,
            Some(false) => ProviderAuth::Unauthenticated,
        };
        Ok(ProviderStatus {
            provider_id: ProviderId::ClaudeCode,
            installed: true,
            executable_path: Some(executable_path),
            version,
            auth,
            message: (login == Some(false)).then(|| "Run `claude` to sign in.".to_owned()),
        })
    }

    async fn list_models(&self, cwd: Option<&str>) -> RunnerResult<ProviderModels> {
        let env = (self.base_env)().await;
        let executable =
            self.config.executable(&env).await.map_err(|e| launch_error(&e.message))?;
        let executable = executable.ok_or_else(|| launch_error(MISSING_CLI))?;
        let home = std::env::var("HOME").unwrap_or_default();
        let cwd = cwd.map_or(home, str::to_owned);
        let args: Vec<String> = [
            "--output-format",
            "stream-json",
            "--verbose",
            "--input-format",
            "stream-json",
            "--max-turns",
            "0",
            "--setting-sources=user,project,local",
            "--permission-mode",
            "default",
            "--no-session-persistence",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        let child = (self.config.spawn)(&executable, &args, &cwd, &env);
        let client = ClaudeClient::new(child, Arc::new(ModelHandlers));
        let ready = client.initialize(InitializeParams::default()).await;
        client.end_input();
        client.close().await;
        let result = ready.map_err(|error| launch_error(&error.to_string()))?;
        let models = options::parse_models(result.get("models").unwrap_or(&Value::Null));
        if models.is_empty() {
            return Err(launch_error("Claude Code reported no models."));
        }
        Ok(options::build_models(&models))
    }

    async fn open(
        &self,
        spec: SessionSpec,
        options: ExecutionOptions,
        host: SessionHost,
    ) -> RunnerResult<Arc<dyn ProviderSession>> {
        let session = ClaudeSession::new(spec, options, host).start(&self.config).await?;
        Ok(Arc::new(session))
    }
}

pub fn create_claude_adapter(options: ClaudeAdapterOptions) -> Arc<dyn ProviderAdapter> {
    let spawn = options.spawn.unwrap_or_else(|| Arc::new(spawn_claude));
    let session_id = options.session_id.unwrap_or_else(|| Arc::new(random_uuid));
    let config = AdapterConfig { spawn, executable: options.executable, session_id };
    let base_env = login_shell_env(EnvMap::new(), String::new());
    Arc::new(ClaudeAdapter { config, base_env })
}
