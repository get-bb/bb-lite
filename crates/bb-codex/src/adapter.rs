use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use bb_core::env::{ChildEnv, EnvMap, login_shell_env};
use bb_core::{
    ExecutionOptions, ProviderAuth, ProviderId, ProviderModels, ProviderStatus, RunnerError,
    RunnerErrorCode, RunnerResult, SessionSpec,
};
use bb_provider::{
    ApprovalEnforcer, Interaction, ProviderAdapter, ProviderSession, SessionHost, SteerInput,
    SteerOutcome, ToolCall, TurnInput,
};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::events::{CodexTranslator, CodexTranslatorHooks, InjectedTools};
use crate::params::{self, POOL_TOKEN, POOL_URL};
use crate::rpc::{
    CodexRpc, ExitInfo, Launch, RequestId, RpcError, RpcHandlers, SpawnAppServer, spawn_app_server,
};

pub const MISSING_CLI: &str = "bb could not find the Codex CLI on this machine. Install Codex (https://developers.openai.com/codex/cli) or put `codex` on PATH, then retry.";
const STATUS_TIMEOUT: Duration = Duration::from_millis(10_000);

/// The TypeScript `CodexAdapterOptions`: `spawn` replaces launching the real app-server and
/// `command` the executable name (`codex`).
#[derive(Clone, Default)]
pub struct CodexAdapterOptions {
    pub spawn: Option<SpawnAppServer>,
    pub command: Option<String>,
}

#[derive(Clone)]
struct AdapterConfig {
    spawn: SpawnAppServer,
    command: String,
}

enum Failure {
    Rpc(RpcError),
    Runner(RunnerError),
}

impl From<RpcError> for Failure {
    fn from(error: RpcError) -> Self {
        Self::Rpc(error)
    }
}

impl From<RunnerError> for Failure {
    fn from(error: RunnerError) -> Self {
        Self::Runner(error)
    }
}

impl Failure {
    fn message(&self) -> &str {
        match self {
            Self::Rpc(error) => &error.message,
            Self::Runner(error) => &error.message,
        }
    }
}

fn launch_error(error: Failure) -> RunnerError {
    match error {
        Failure::Runner(error) => error,
        Failure::Rpc(error) if error.spawn_failed => {
            RunnerError::new(RunnerErrorCode::MissingExecutable, MISSING_CLI)
        }
        Failure::Rpc(error) => RunnerError::failed(error.message),
    }
}

static ARCHIVED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:session|thread)\s+\S+\s+is archived\b").expect("static regex")
});
static ACCOUNT_ERROR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:40[13]|429|unauthori[sz]ed|quota|usage limit)\b").expect("static regex")
});
static APPROVAL_REQUEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^item/\w+/requestApproval$").expect("static regex"));
static NO_ACTIVE_TURN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)no active turn").expect("static regex"));

fn archived(message: &str) -> bool {
    ARCHIVED.is_match(message)
}

fn account_error(detail: &str) -> bool {
    ACCOUNT_ERROR.is_match(detail)
}

fn external_thread_name(title: &str) -> String {
    format!("[bb] {title}")
}

fn utf16_slice(text: &[u16], start: usize, end: usize) -> &[u16] {
    let end = end.min(text.len());
    &text[start.min(end)..end]
}

/// `isStandaloneBuiltinCompactCommand`: the input is exactly the builtin `/compact` command.
pub fn is_standalone_builtin_compact_command(input: &[Value]) -> bool {
    let selected = |mention: &Value| {
        let resource = &mention["resource"];
        resource["kind"] == "command" && resource["trigger"] == "/" && resource["name"] == "compact"
    };
    let mut found = Vec::new();
    for (index, item) in input.iter().enumerate() {
        if item["type"] != "text" {
            return false;
        }
        let mentions = item["mentions"].as_array().map(Vec::as_slice).unwrap_or_default();
        found.extend(mentions.iter().filter(|mention| selected(mention)).map(|m| (index, m)));
    }
    let [(owner, mention)] = found.as_slice() else { return false };
    let resource = &mention["resource"];
    let builtin = resource["source"] == "command" && resource["origin"] == "builtin";
    let text = |item: &Value| item["text"].as_str().unwrap_or_default().to_owned();
    let units: Vec<u16> = text(&input[*owner]).encode_utf16().collect();
    let start = mention["start"].as_u64().unwrap_or(0) as usize;
    let end = mention["end"].as_u64().unwrap_or(0) as usize;
    let command: Vec<u16> = "/compact".encode_utf16().collect();
    if !builtin || utf16_slice(&units, start, end) != command.as_slice() {
        return false;
    }
    let mut rest = utf16_slice(&units, 0, start).to_vec();
    rest.extend_from_slice(utf16_slice(&units, end, units.len()));
    input.iter().enumerate().all(|(index, item)| {
        let remaining = if index == *owner { String::from_utf16_lossy(&rest) } else { text(item) };
        remaining.trim().is_empty()
    })
}

struct Shared {
    provider_thread_id: Mutex<String>,
    rebuild: AtomicBool,
}

impl CodexTranslatorHooks for Shared {
    fn root_thread_id(&self) -> Option<String> {
        let id = self.provider_thread_id.lock();
        (!id.is_empty()).then(|| id.clone())
    }

    fn on_terminal_error(&self, category: &str, detail: &str) {
        let account = category == "unauthorized" || category == "rate-limit";
        let guessed = category == "unknown" && account_error(detail);
        if account || guessed {
            self.rebuild.store(true, Ordering::SeqCst);
        }
    }
}

struct SessionHandlers {
    translator: Arc<Mutex<CodexTranslator>>,
    host: SessionHost,
}

fn is_approval(method: &str) -> bool {
    APPROVAL_REQUEST.is_match(method)
}

fn parse_tool_call(params: &Value) -> Option<(Option<String>, String, String, Value)> {
    let turn_id = match params.get("turnId")? {
        Value::Null => None,
        Value::String(turn) => Some(turn.clone()),
        _ => return None,
    };
    let call_id = params["callId"].as_str().filter(|id| !id.is_empty())?;
    let tool = params["tool"].as_str().filter(|tool| !tool.is_empty())?;
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    Some((turn_id, call_id.to_owned(), tool.to_owned(), arguments))
}

impl SessionHandlers {
    fn bb_turn_id(&self, turn_id: Option<String>) -> Option<String> {
        turn_id.map(|turn| self.host.events.bb_turn_id(&turn).unwrap_or(turn))
    }

    fn serve_tool_call(&self, rpc: &CodexRpc, id: RequestId, call: ToolCall) {
        let (rpc, host) = (rpc.clone(), self.host.clone());
        tokio::spawn(async move {
            match host.call_tool(call).await {
                Ok(response) => match serde_json::to_value(response) {
                    Ok(result) => rpc.respond(&id, result),
                    Err(error) => rpc.reject(&id, -32000, &error.to_string()),
                },
                Err(error) => rpc.reject(&id, -32000, &error.message),
            }
        });
    }

    fn serve_approval(&self, rpc: &CodexRpc, id: RequestId, method: &str, params: &Value) {
        let events = &self.host.events;
        let decoded = params::decode_approval(method, params).and_then(|payload| {
            let turn = params::parse_approval(params)?.turn_id;
            Ok((payload, turn))
        });
        let (mut payload, turn) = match decoded {
            Ok(decoded) => decoded,
            Err(error) => return rpc.reject(&id, -32602, &error.message),
        };
        if payload["kind"] != "approval" {
            return;
        }
        if let Some(item) = payload["subject"]["itemId"].as_str().map(str::to_owned) {
            let mapped = events.bb_item_id(&item).unwrap_or(item);
            payload["subject"]["itemId"] = mapped.into();
        }
        let interaction = Interaction { payload, turn_id: self.bb_turn_id(Some(turn)) };
        let (rpc, host, method) = (rpc.clone(), self.host.clone(), method.to_owned());
        tokio::spawn(async move {
            match host.request_interaction(interaction).await {
                Ok(resolution) => rpc.respond(&id, params::encode_approval(&method, &resolution)),
                Err(error) => rpc.reject(&id, -32000, &error.message),
            }
        });
    }
}

impl RpcHandlers for SessionHandlers {
    fn on_notification(&self, method: &str, params: Value) {
        self.translator.lock().handle(method, &params);
    }

    fn on_request(&self, rpc: &CodexRpc, id: RequestId, method: &str, params: Value) {
        if method == "item/tool/call"
            && let Some((turn_id, call_id, tool, arguments)) = parse_tool_call(&params)
        {
            let call_id = self.host.events.bb_item_id(&call_id).unwrap_or(call_id);
            let turn_id = self.bb_turn_id(turn_id);
            return self.serve_tool_call(rpc, id, ToolCall { call_id, tool, arguments, turn_id });
        }
        if !is_approval(method) {
            return rpc.reject(&id, -32601, &format!("Unhandled codex request \"{method}\""));
        }
        self.serve_approval(rpc, id, method, &params);
    }

    fn on_exit(&self, info: ExitInfo) {
        let ExitInfo { message, stderr_tail } = info;
        self.host.on_exit(bb_provider::ExitInfo { message, stderr_tail });
    }
}

pub struct CodexSession {
    spec: SessionSpec,
    host: SessionHost,
    rpc: CodexRpc,
    translator: Arc<Mutex<CodexTranslator>>,
    shared: Arc<Shared>,
    signature: String,
}

fn signature_of(spec: &SessionSpec, options: &ExecutionOptions) -> String {
    let data = params::provider_options(options).ok().map(|custom| {
        json!([
            custom.memory_enabled,
            custom.provider_subagents_enabled,
            custom.additional_workspace_write_roots
        ])
    });
    let token = spec.env.get(POOL_TOKEN).map(String::as_str).unwrap_or_default();
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let permissions = format!("{:?}", params::permission_settings(options));
    let pool = json!([spec.env.get(POOL_URL), token_hash]);
    json!([spec.cwd, data, permissions, pool]).to_string()
}

fn describe_rpc(error: RpcError) -> RunnerError {
    RunnerError::failed(error.message)
}

impl CodexSession {
    fn new(
        spec: SessionSpec,
        options: &ExecutionOptions,
        host: SessionHost,
        adapter: &AdapterConfig,
    ) -> Self {
        let signature = signature_of(&spec, options);
        let injected: InjectedTools = spec
            .dynamic_tools
            .iter()
            .map(|tool| {
                let presentation =
                    tool.presentation.clone().and_then(|value| serde_json::from_value(value).ok());
                (tool.name.clone(), presentation)
            })
            .collect();
        let resumed = spec.provider_thread_id.is_some();
        let shared = Arc::new(Shared {
            provider_thread_id: Mutex::new(String::new()),
            rebuild: false.into(),
        });
        let hooks: Arc<dyn CodexTranslatorHooks> = shared.clone();
        let translator = CodexTranslator::new(host.events.clone(), injected, hooks, resumed);
        let translator = Arc::new(Mutex::new(translator));
        let mut env: EnvMap = host.process_env.clone();
        for name in [POOL_URL, POOL_TOKEN] {
            if let Some(value) = spec.env.get(name).filter(|value| !value.is_empty()) {
                env.insert(name.to_owned(), value.clone());
            }
        }
        let mut args = vec!["app-server".to_owned()];
        args.extend(params::pool_args(&spec.env));
        let launch = Launch { cwd: spec.cwd.clone(), env };
        let child = (adapter.spawn)(&adapter.command, &args, launch);
        let handlers = SessionHandlers { translator: translator.clone(), host: host.clone() };
        let rpc = CodexRpc::new(child, Arc::new(handlers));
        Self { spec, host, rpc, translator, shared, signature }
    }

    fn thread_id(&self) -> String {
        self.shared.provider_thread_id.lock().clone()
    }

    async fn start(self, options: &ExecutionOptions) -> RunnerResult<Self> {
        match self.construct(options).await {
            Ok(()) => Ok(self),
            Err(error) => {
                self.rpc.kill().await;
                Err(launch_error(error))
            }
        }
    }

    async fn construct(&self, options: &ExecutionOptions) -> Result<(), Failure> {
        let (spec, rpc) = (&self.spec, &self.rpc);
        rpc.request("initialize", params::initialize_params()).await?;
        if !spec.skill_dirs.is_empty() {
            let params = json!({ "extraRoots": spec.skill_dirs });
            rpc.request("skills/extraRoots/set", params).await?;
        }
        let shared = self.construction_params(options).await?;
        let resume_id = spec.provider_thread_id.clone();
        if let Some(resume) = &resume_id {
            self.host.events.identity(resume);
        }
        let construct = || async {
            match &resume_id {
                Some(resume) => {
                    let params = params::thread_resume_params(resume, shared.clone());
                    rpc.request("thread/resume", params).await
                }
                None => {
                    rpc.request("thread/start", params::thread_start_params(shared.clone())).await
                }
            }
        };
        let result = match (construct().await, &resume_id) {
            (Err(error), Some(resume)) if archived(&error.message) => {
                rpc.request("thread/unarchive", json!({ "threadId": resume })).await?;
                construct().await?
            }
            (result, _) => result?,
        };
        let id = result["thread"]["id"].as_str().filter(|id| !id.is_empty());
        let id = id.ok_or_else(|| RunnerError::failed("Codex returned no thread id"))?;
        *self.shared.provider_thread_id.lock() = id.to_owned();
        if resume_id.is_none() {
            self.host.events.identity(id);
        }
        Ok(())
    }

    async fn roots(&self, options: &ExecutionOptions) -> RunnerResult<Vec<String>> {
        let custom = params::provider_options(options)?;
        let extra = custom.additional_workspace_write_roots.unwrap_or_default();
        let git = params::git_writable_roots(&self.spec.cwd).await;
        let mut roots: Vec<String> = Vec::new();
        for root in self.host.writable_roots.iter().cloned().chain(extra).chain(git) {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
        Ok(roots)
    }

    async fn sandbox_roots(&self, options: &ExecutionOptions) -> RunnerResult<Vec<String>> {
        if params::permission_settings(options).sandboxed() {
            self.roots(options).await
        } else {
            Ok(Vec::new())
        }
    }

    async fn construction_params(
        &self,
        options: &ExecutionOptions,
    ) -> RunnerResult<Map<String, Value>> {
        let roots = self.sandbox_roots(options).await?;
        params::construction_params(&self.spec, options, &self.host.env, &roots)
    }

    async fn run_turn(
        &self,
        thread_id: &str,
        input: &[Value],
        options: &ExecutionOptions,
    ) -> Result<(), Failure> {
        if is_standalone_builtin_compact_command(input) {
            let params = json!({ "threadId": thread_id });
            self.rpc.request("thread/compact/start", params).await?;
            return Ok(());
        }
        let roots = self.sandbox_roots(options).await?;
        let params = params::turn_start_params(thread_id, input, options, &roots)?;
        let result = self.rpc.request("turn/start", params).await?;
        let turn = &result["turn"];
        let (id, status, _) = CodexTranslator::parse_turn(turn)
            .ok_or_else(|| RunnerError::failed("Codex returned an invalid turn"))?;
        let mut translator = self.translator.lock();
        translator.open_turn(thread_id, &id);
        if status != "inProgress" {
            translator.close_turn(thread_id, turn);
        }
        Ok(())
    }
}

#[async_trait]
impl ProviderSession for CodexSession {
    fn provider_thread_id(&self) -> String {
        self.thread_id()
    }

    fn can_apply(&self, spec: &SessionSpec, options: &ExecutionOptions) -> bool {
        let unchanged = signature_of(spec, options) == self.signature;
        unchanged && !self.shared.rebuild.load(Ordering::SeqCst) && !self.rpc.exited()
    }

    async fn start_turn(&self, args: TurnInput) -> RunnerResult<()> {
        let events = &self.host.events;
        let thread_id = self.thread_id();
        events.accept_input(&args.client_request_id, None);
        let outcome = self.run_turn(&thread_id, &args.input, &args.options).await;
        outcome.map_err(|error| {
            events.retract_input(&args.client_request_id);
            RunnerError::failed(error.message())
        })
    }

    async fn steer(&self, args: SteerInput) -> RunnerResult<SteerOutcome> {
        let events = &self.host.events;
        let Some(turn) = events.provider_turn_id(&args.expected_turn_id) else {
            return Ok(SteerOutcome::Stale);
        };
        if self.rpc.exited() {
            return Ok(SteerOutcome::Stale);
        }
        let input = params::to_codex_input(&args.input);
        let params =
            json!({ "threadId": self.thread_id(), "expectedTurnId": turn, "input": input });
        if let Err(error) = self.rpc.request("turn/steer", params).await {
            if NO_ACTIVE_TURN.is_match(&error.message) {
                return Ok(SteerOutcome::Stale);
            }
            return Err(describe_rpc(error));
        }
        events.accept_input(&args.client_request_id, Some(&turn));
        Ok(SteerOutcome::Steered)
    }

    async fn interrupt(&self) -> RunnerResult<()> {
        let events = &self.host.events;
        let turn = events.active_turn_id().and_then(|active| events.provider_turn_id(&active));
        let Some(turn_id) = turn else { return Ok(()) };
        if self.rpc.exited() {
            return Ok(());
        }
        let params = json!({ "threadId": self.thread_id(), "turnId": turn_id });
        self.rpc.request("turn/interrupt", params).await.map_err(describe_rpc)?;
        Ok(())
    }

    async fn close(&self) -> RunnerResult<()> {
        self.translator.lock().close_agents(None);
        self.rpc.kill().await;
        Ok(())
    }

    fn supports_rename(&self) -> bool {
        true
    }

    async fn rename(&self, title: &str) -> RunnerResult<()> {
        let params = json!({ "threadId": self.thread_id(), "name": external_thread_name(title) });
        self.rpc.request("thread/name/set", params).await.map_err(describe_rpc)?;
        Ok(())
    }
}

fn executable(file: &str) -> bool {
    std::ffi::CString::new(file)
        .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::X_OK) } == 0)
}

fn find_executable(command: &str, path: &str) -> Option<String> {
    let dirs: Vec<&str> =
        if Path::new(command).is_absolute() { vec![""] } else { path.split(':').collect() };
    dirs.into_iter()
        .map(|dir| {
            if dir.is_empty() {
                command.to_owned()
            } else {
                Path::new(dir).join(command).to_string_lossy().into_owned()
            }
        })
        .find(|file| executable(file))
}

async fn run_quietly(executable: &str, args: &[&str], env: &EnvMap) -> Option<String> {
    let mut command = tokio::process::Command::new(executable);
    command.args(args).env_clear().envs(env).kill_on_drop(true);
    command.stdin(std::process::Stdio::null());
    let output = tokio::time::timeout(STATUS_TIMEOUT, command.output()).await.ok()?.ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    output.status.success().then_some(stdout)
}

struct ListModelsHandlers;

impl RpcHandlers for ListModelsHandlers {
    fn on_notification(&self, _method: &str, _params: Value) {}

    fn on_request(&self, rpc: &CodexRpc, id: RequestId, _method: &str, _params: Value) {
        rpc.reject(&id, -32601, "Unhandled codex request");
    }

    fn on_exit(&self, _info: ExitInfo) {}
}

struct CodexAdapter {
    config: AdapterConfig,
    base_env: ChildEnv,
}

#[async_trait]
impl ProviderAdapter for CodexAdapter {
    fn id(&self) -> ProviderId {
        ProviderId::Codex
    }

    fn approval_enforced_by(&self) -> ApprovalEnforcer {
        ApprovalEnforcer::Runner
    }

    async fn status(&self) -> RunnerResult<ProviderStatus> {
        let env = (self.base_env)().await;
        let path = env.get("PATH").cloned().unwrap_or_default();
        let command = self.config.command.clone();
        let found = tokio::task::spawn_blocking(move || find_executable(&command, &path))
            .await
            .map_err(|error| RunnerError::failed(error.to_string()))?;
        let Some(executable_path) = found else {
            return Ok(ProviderStatus {
                provider_id: ProviderId::Codex,
                installed: false,
                executable_path: None,
                version: None,
                auth: ProviderAuth::Unknown,
                message: Some(MISSING_CLI.to_owned()),
            });
        };
        let version = run_quietly(&executable_path, &["--version"], &env).await;
        let version =
            version.map(|out| out.split_whitespace().last().unwrap_or_default().to_owned());
        let signed_in = run_quietly(&executable_path, &["login", "status"], &env).await.is_some();
        Ok(ProviderStatus {
            provider_id: ProviderId::Codex,
            installed: true,
            executable_path: Some(executable_path),
            version,
            auth: if signed_in { ProviderAuth::Ready } else { ProviderAuth::Unauthenticated },
            message: (!signed_in).then(|| "Run `codex login` to sign in.".to_owned()),
        })
    }

    async fn list_models(&self, cwd: Option<&str>) -> RunnerResult<ProviderModels> {
        let home = std::env::var("HOME").unwrap_or_default();
        let launch = Launch { cwd: cwd.map_or(home, str::to_owned), env: (self.base_env)().await };
        let args = ["app-server".to_owned()];
        let child = (self.config.spawn)(&self.config.command, &args, launch);
        let rpc = CodexRpc::new(child, Arc::new(ListModelsHandlers));
        let listed = async {
            rpc.request("initialize", params::initialize_params()).await?;
            let result = rpc.request("model/list", json!({})).await?;
            Ok::<_, Failure>(params::parse_models(&result)?)
        }
        .await;
        rpc.kill().await;
        let models = listed.map_err(launch_error)?;
        Ok(ProviderModels { models, selected_only_models: Vec::new() })
    }

    async fn open(
        &self,
        spec: SessionSpec,
        options: ExecutionOptions,
        host: SessionHost,
    ) -> RunnerResult<Arc<dyn ProviderSession>> {
        let session = CodexSession::new(spec, &options, host, &self.config);
        Ok(Arc::new(session.start(&options).await?))
    }
}

pub fn create_codex_adapter(options: CodexAdapterOptions) -> Arc<dyn ProviderAdapter> {
    let spawn = options.spawn.unwrap_or_else(|| Arc::new(spawn_app_server));
    let command = options.command.unwrap_or_else(|| "codex".to_owned());
    let base_env = login_shell_env(EnvMap::new(), String::new());
    Arc::new(CodexAdapter { config: AdapterConfig { spawn, command }, base_env })
}
