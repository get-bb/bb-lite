use std::collections::HashSet;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use bb_core::types::{
    AvailableModel, DynamicTool, ExecutionOptions, ModelReasoningEffort, PermissionMode,
    ProviderModels, ReasoningLevel, ServiceTier, SessionSpec, ToolCallOutputItem, ToolCallResponse,
};
use bb_core::{RunnerError, RunnerErrorCode, RunnerResult};
use bb_provider::SessionHost;
use futures::future::BoxFuture;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::mcp::{McpCallTool, McpServer, McpTool, McpToolResult};
use crate::protocol::InitializeParams;
use crate::tools::BB_MCP_SERVER;

pub const EXECUTABLE_ENV: &str = "BB_CLAUDE_CODE_EXECUTABLE";
pub const SKILL_PLUGIN: &str = "bb-global-skills";
/// The Agent SDK version whose behaviour this module reproduces (`CLAUDE_AGENT_SDK_VERSION`).
pub const SDK_VERSION: &str = "0.3.268";
/// The callback id of the single PreToolUse hook registered in `initialize`.
pub const PRE_TOOL_USE_HOOK: &str = "hook_0";
pub const DISALLOWED_TOOLS: [&str; 2] = ["EnterPlanMode", "ExitPlanMode"];
pub const SETTING_SOURCES: [&str; 3] = ["user", "project", "local"];

static MODEL_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$")
        .unwrap_or_else(|_| Regex::new("$^").unwrap_or_else(|_| unreachable!()))
});

/// The CLI's `--permission-mode` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClaudePermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    DontAsk,
    Auto,
}

impl ClaudePermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::BypassPermissions => "bypassPermissions",
            Self::Plan => "plan",
            Self::DontAsk => "dontAsk",
            Self::Auto => "auto",
        }
    }

    pub fn from_bb(mode: PermissionMode) -> Self {
        match mode {
            PermissionMode::AcceptEdits => Self::AcceptEdits,
            PermissionMode::Auto => Self::Auto,
            PermissionMode::Full => Self::BypassPermissions,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProviderOptions {
    pub memory_enabled: Option<bool>,
    pub subagents_disabled: Option<bool>,
    pub workflows_disabled: Option<bool>,
    pub disable_1m_context: Option<bool>,
    pub chrome_enabled: Option<bool>,
    pub additional_workspace_write_roots: Option<Vec<String>>,
}

/// Parses `providerOptions`; any field of the wrong type discards all of them, as `safeParse` does.
pub fn parse_provider_options(options: &Map<String, Value>) -> ProviderOptions {
    fn flag(options: &Map<String, Value>, key: &str) -> Result<Option<bool>, ()> {
        match options.get(key) {
            None => Ok(None),
            Some(Value::Bool(value)) => Ok(Some(*value)),
            Some(_) => Err(()),
        }
    }
    let parsed = || -> Result<ProviderOptions, ()> {
        let roots = match options.get("additionalWorkspaceWriteRoots") {
            None => None,
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|item| item.as_str().map(str::to_owned).ok_or(()))
                    .collect::<Result<Vec<_>, ()>>()?,
            ),
            Some(_) => return Err(()),
        };
        Ok(ProviderOptions {
            memory_enabled: flag(options, "memoryEnabled")?,
            subagents_disabled: flag(options, "subagentsDisabled")?,
            workflows_disabled: flag(options, "workflowsDisabled")?,
            disable_1m_context: flag(options, "disable1MContext")?,
            chrome_enabled: flag(options, "chromeEnabled")?,
            additional_workspace_write_roots: roots,
        })
    };
    parsed().unwrap_or_default()
}

pub fn sdk_effort(level: ReasoningLevel) -> &'static str {
    match level {
        ReasoningLevel::Ultracode => "xhigh",
        ReasoningLevel::None => "low",
        ReasoningLevel::Ultra => "max",
        other => other.as_str(),
    }
}

/// The flag settings, in the order the SDK serializes them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeFlags {
    pub auto_memory_enabled: bool,
    pub enable_workflows: bool,
    pub effort_level: &'static str,
    pub ultracode: bool,
    pub fast_mode: bool,
}

impl ClaudeFlags {
    /// All flags as JSON, `effortLevel` included (the `apply_flag_settings` payload).
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }

    /// The flags without `effortLevel`: the `settings` option given at launch.
    pub fn launch_json(&self) -> Map<String, Value> {
        let mut map = match self.to_json() {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        map.shift_remove("effortLevel");
        map
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeSettings {
    pub model: String,
    pub subagents: bool,
    pub workflows: bool,
    pub disable_1m_context: bool,
    pub chrome: bool,
    pub writable_roots: Vec<String>,
    pub base_mode: ClaudePermissionMode,
    pub flags: ClaudeFlags,
}

impl ClaudeSettings {
    /// `[baseMode, disable1MContext, chrome, writableRoots]`: the parts that need a new process.
    pub fn fixed(&self) -> Value {
        json!([self.base_mode, self.disable_1m_context, self.chrome, self.writable_roots])
    }
}

pub fn claude_settings(options: &ExecutionOptions) -> ClaudeSettings {
    let custom = parse_provider_options(&options.provider_options);
    let workflows = custom.workflows_disabled != Some(true);
    ClaudeSettings {
        model: options.model.clone(),
        subagents: custom.subagents_disabled != Some(true),
        workflows,
        disable_1m_context: custom.disable_1m_context == Some(true),
        chrome: custom.chrome_enabled == Some(true),
        writable_roots: custom.additional_workspace_write_roots.unwrap_or_default(),
        base_mode: ClaudePermissionMode::from_bb(options.permission_mode),
        flags: ClaudeFlags {
            auto_memory_enabled: custom.memory_enabled != Some(false),
            enable_workflows: workflows,
            effort_level: sdk_effort(options.reasoning_level),
            ultracode: options.reasoning_level == ReasoningLevel::Ultracode,
            fast_mode: options.service_tier == ServiceTier::Fast,
        },
    }
}

pub fn start_mode_for(mode: ClaudePermissionMode, is_root: bool) -> ClaudePermissionMode {
    let refused = mode == ClaudePermissionMode::BypassPermissions && is_root;
    if refused { ClaudePermissionMode::Default } else { mode }
}

/// `bypassPermissions` becomes `default` when running as root.
pub fn start_mode(mode: ClaudePermissionMode) -> ClaudePermissionMode {
    start_mode_for(mode, unsafe { libc::getuid() } == 0)
}

fn is_executable(path: &Path) -> bool {
    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else { return false };
    if unsafe { libc::access(c_path.as_ptr(), libc::X_OK) } != 0 {
        return false;
    }
    std::fs::metadata(path).map(|info| info.is_file()).unwrap_or(false)
}

/// `explicit` stands for `BB_CLAUDE_CODE_EXECUTABLE`; otherwise `claude` is searched on `env.PATH`.
pub fn resolve_executable_with(
    explicit: Option<&str>,
    env: &IndexMap<String, String>,
) -> RunnerResult<Option<String>> {
    if let Some(explicit) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        if is_executable(Path::new(explicit)) {
            return Ok(Some(explicit.to_owned()));
        }
        let message =
            format!("{EXECUTABLE_ENV} must point to an executable Claude CLI path: {explicit}");
        return Err(RunnerError::new(RunnerErrorCode::MissingExecutable, message));
    }
    let path = env.get("PATH").map(String::as_str).unwrap_or_default();
    for dir in path.split(':').filter(|dir| !dir.is_empty()) {
        let candidate = Path::new(dir).join("claude");
        if is_executable(&candidate) {
            return Ok(Some(candidate.to_string_lossy().into_owned()));
        }
    }
    Ok(None)
}

pub async fn resolve_executable(env: &IndexMap<String, String>) -> RunnerResult<Option<String>> {
    let explicit = std::env::var(EXECUTABLE_ENV).ok();
    let env = env.clone();
    tokio::task::spawn_blocking(move || resolve_executable_with(explicit.as_deref(), &env))
        .await
        .unwrap_or(Ok(None))
}

pub fn skill_plugin_root() -> PathBuf {
    let uid = unsafe { libc::getuid() };
    std::env::temp_dir().join(format!("bb-claude-skill-plugins-{uid}"))
}

fn assemble_plugin(path: &Path, link: &Path, dir: &str, manifest: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(path.join(".claude-plugin"))?;
    let text = serde_json::to_string_pretty(manifest).map_err(std::io::Error::other)?;
    std::fs::write(path.join(".claude-plugin").join("plugin.json"), format!("{text}\n"))?;
    if linked(link, dir) {
        return Ok(());
    }
    match std::fs::symlink_metadata(link) {
        Ok(info) if info.is_dir() => std::fs::remove_dir_all(link)?,
        Ok(_) => std::fs::remove_file(link)?,
        Err(_) => {}
    }
    std::os::unix::fs::symlink(dir, link)
}

fn linked(link: &Path, dir: &str) -> bool {
    std::fs::read_link(link).map(|target| target.as_os_str() == dir).unwrap_or(false)
}

/// Materialises one local plugin per distinct skill directory under `root`; returns their paths.
pub fn skill_plugins_in(root: &Path, skill_dirs: &[String]) -> Vec<String> {
    let mut plugins = Vec::new();
    for dir in unique(skill_dirs.iter().cloned()) {
        let digest = hex::encode(Sha256::digest(dir.as_bytes()));
        let id = &digest[..16];
        let path = root.join(id);
        let link = path.join("skills");
        let suffix = if plugins.is_empty() { String::new() } else { format!("-{}", &id[..8]) };
        let manifest = json!({
            "$schema": "https://anthropic.com/claude-code/plugin.schema.json",
            "name": format!("{SKILL_PLUGIN}{suffix}"),
            "version": "0.1.0",
            "description": format!("Skills injected by bb ({dir})."),
            "author": {"name": "bb"},
            "skills": "./skills",
        });
        let _ = assemble_plugin(&path, &link, &dir, &manifest);
        if linked(&link, &dir) {
            plugins.push(path.to_string_lossy().into_owned());
        }
    }
    plugins
}

pub async fn skill_plugins(skill_dirs: &[String]) -> Vec<String> {
    let dirs = skill_dirs.to_vec();
    tokio::task::spawn_blocking(move || skill_plugins_in(&skill_plugin_root(), &dirs))
        .await
        .unwrap_or_default()
}

fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

/// The parts of `SessionHost` the launch needs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchHost {
    pub process_env: IndexMap<String, String>,
    pub env: IndexMap<String, String>,
    pub writable_roots: Vec<String>,
}

impl From<&SessionHost> for LaunchHost {
    fn from(host: &SessionHost) -> Self {
        Self {
            process_env: host.process_env.clone(),
            env: host.env.clone(),
            writable_roots: host.writable_roots.clone(),
        }
    }
}

/// How the process starts its conversation: `--session-id=` or `--resume=`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionStart {
    New(String),
    Resume(String),
}

impl SessionStart {
    /// Resume `spec.providerThreadId` when set, else a new session with `new_id`.
    pub fn for_spec(spec: &SessionSpec, new_id: impl Into<String>) -> Self {
        match &spec.provider_thread_id {
            Some(id) => Self::Resume(id.clone()),
            None => Self::New(new_id.into()),
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::New(id) | Self::Resume(id) => id,
        }
    }
}

/// Everything resolved from disk and the environment before building argv.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchContext {
    pub executable: Option<String>,
    pub plugins: Vec<String>,
    pub is_root: bool,
}

/// What the Agent SDK would have spawned and sent for `buildQueryOptions` plus claude.ts's options.
#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeLaunch {
    pub executable: Option<String>,
    pub cwd: String,
    pub args: Vec<String>,
    pub env: IndexMap<String, String>,
    pub initialize: InitializeParams,
    pub permission_mode: ClaudePermissionMode,
    pub session: SessionStart,
}

/// The adapter's env plus the SDK's own adjustments, in insertion order.
pub fn child_env(host: &LaunchHost, settings: &ClaudeSettings) -> IndexMap<String, String> {
    let mut env = host.process_env.clone();
    env.extend(host.env.clone());
    env.insert("CLAUDE_CODE_ENTRYPOINT".into(), "cli".into());
    let disable = if settings.disable_1m_context { "1" } else { "0" };
    env.insert("CLAUDE_CODE_DISABLE_1M_CONTEXT".into(), disable.into());
    env.shift_remove("CLAUDE_AGENT_SDK_CLIENT_APP");
    env.shift_remove("ELECTRON_RUN_AS_NODE");
    env.insert("CLAUDE_AGENT_SDK_VERSION".into(), SDK_VERSION.into());
    let debug = env.contains_key("DEBUG_CLAUDE_AGENT_SDK");
    env.shift_remove("DEBUG");
    if debug {
        env.insert("DEBUG".into(), "1".into());
    }
    env.shift_remove("NODE_OPTIONS");
    env
}

/// The `sandbox` settings, or `None` in bypass mode.
pub fn sandbox_settings(roots: &[String], bypass: bool) -> Option<Value> {
    if bypass {
        return None;
    }
    let mut sandbox = json!({
        "enabled": true,
        "failIfUnavailable": false,
        "autoAllowBashIfSandboxed": true,
        "allowUnsandboxedCommands": true,
        "network": {"allowLocalBinding": true},
    });
    if let (false, Value::Object(map)) = (roots.is_empty(), &mut sandbox) {
        map.insert("filesystem".into(), json!({"allowWrite": roots}));
    }
    Some(sandbox)
}

/// The `--settings` JSON: launch flags, plus `sandbox` unless bypassing.
pub fn settings_json(settings: &ClaudeSettings, roots: &[String]) -> Value {
    let bypass = settings.base_mode == ClaudePermissionMode::BypassPermissions;
    let mut map = settings.flags.launch_json();
    if let Some(sandbox) = sandbox_settings(roots, bypass) {
        map.insert("sandbox".into(), sandbox);
    }
    Value::Object(map)
}

/// `mcp__bb-bridge__<tool>` for each dynamic tool (the `allowedTools` option).
pub fn allowed_tools(tools: &[DynamicTool]) -> Vec<String> {
    tools.iter().map(|tool| format!("mcp__{BB_MCP_SERVER}__{}", tool.name)).collect()
}

pub fn initialize_params(spec: &SessionSpec) -> InitializeParams {
    InitializeParams {
        hooks: Some(json!({"PreToolUse": [{"hookCallbackIds": [PRE_TOOL_USE_HOOK]}]})),
        sdk_mcp_servers: (!spec.dynamic_tools.is_empty()).then(|| vec![BB_MCP_SERVER.to_owned()]),
        append_system_prompt: Some(spec.instructions.clone()).filter(|text| !text.is_empty()),
        ..InitializeParams::default()
    }
}

/// Builds argv, env and `initialize` without touching the filesystem.
pub fn build_launch_with(
    spec: &SessionSpec,
    settings: &ClaudeSettings,
    host: &LaunchHost,
    session: SessionStart,
    context: LaunchContext,
) -> ClaudeLaunch {
    let env = child_env(host, settings);
    let bypass = settings.base_mode == ClaudePermissionMode::BypassPermissions;
    let roots = unique(host.writable_roots.iter().chain(&settings.writable_roots).cloned());
    let mode = start_mode_for(settings.base_mode, context.is_root);
    let mut args: Vec<String> = ["--output-format", "stream-json", "--verbose"]
        .into_iter()
        .chain(["--input-format", "stream-json", "--thinking", "adaptive"])
        .chain(["--thinking-display", "summarized", "--effort", settings.flags.effort_level])
        .map(str::to_owned)
        .collect();
    if !settings.model.is_empty() {
        args.extend(["--model".to_owned(), settings.model.clone()]);
    }
    args.extend(["--permission-prompt-tool".to_owned(), "stdio".to_owned()]);
    if let SessionStart::Resume(id) = &session {
        args.push(format!("--resume={id}"));
    }
    if !spec.dynamic_tools.is_empty() {
        args.extend(["--allowedTools".to_owned(), allowed_tools(&spec.dynamic_tools).join(",")]);
    }
    args.extend(["--disallowedTools".to_owned(), DISALLOWED_TOOLS.join(",")]);
    args.push(format!("--setting-sources={}", SETTING_SOURCES.join(",")));
    args.extend(["--permission-mode".to_owned(), mode.as_str().to_owned()]);
    if mode == ClaudePermissionMode::BypassPermissions {
        args.push("--allow-dangerously-skip-permissions".to_owned());
    }
    args.push("--include-partial-messages".to_owned());
    if !bypass {
        for root in &roots {
            args.extend(["--add-dir".to_owned(), root.clone()]);
        }
    }
    for plugin in &context.plugins {
        args.extend(["--plugin-dir".to_owned(), plugin.clone()]);
    }
    if let SessionStart::New(id) = &session {
        args.push(format!("--session-id={id}"));
    }
    args.push("--replay-user-messages".to_owned());
    if settings.chrome {
        args.push("--chrome".to_owned());
    }
    args.extend(["--settings".to_owned(), settings_json(settings, &roots).to_string()]);
    ClaudeLaunch {
        executable: context.executable,
        cwd: spec.cwd.clone(),
        args,
        env,
        initialize: initialize_params(spec),
        permission_mode: mode,
        session,
    }
}

/// `buildQueryOptions` plus the options claude.ts adds, as the SDK would have spawned them.
pub async fn build_launch(
    spec: &SessionSpec,
    settings: &ClaudeSettings,
    host: &LaunchHost,
    session: SessionStart,
) -> RunnerResult<ClaudeLaunch> {
    let env = child_env(host, settings);
    let executable = resolve_executable(&env).await?;
    let plugins = skill_plugins(&spec.skill_dirs).await;
    let is_root = unsafe { libc::getuid() } == 0;
    let context = LaunchContext { executable, plugins, is_root };
    Ok(build_launch_with(spec, settings, host, session, context))
}

/// The text sent for a prompt (`PromptInput[]` as JSON).
pub fn prompt_text(input: &[Value]) -> Option<String> {
    let on_disk = |path: &str| format!("It is on disk at {path} — use the Read tool to view it.]");
    let field = |item: &Value, key: &str| item.get(key).and_then(Value::as_str).map(str::to_owned);
    let mut chunks = Vec::new();
    for item in input {
        match item.get("type").and_then(Value::as_str) {
            Some("image") => {
                chunks.push(format!("[Attached image: {}]", field(item, "url").unwrap_or_default()))
            }
            Some("localImage") => {
                let path = field(item, "path").unwrap_or_default();
                chunks.push(format!("[Attached image. {}", on_disk(&path)));
            }
            Some("localFile") => {
                let size = item.get("sizeBytes").and_then(Value::as_f64).map(|n| {
                    let number = Value::from(n).to_string();
                    format!("{} bytes", number.trim_end_matches(".0"))
                });
                let details: Vec<String> = [field(item, "mimeType"), size]
                    .into_iter()
                    .flatten()
                    .filter(|part| !part.is_empty())
                    .collect();
                let name = field(item, "name")
                    .filter(|name| !name.is_empty())
                    .map(|name| format!(" \"{name}\""))
                    .unwrap_or_default();
                let suffix = if details.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", details.join(", "))
                };
                let path = field(item, "path").unwrap_or_default();
                chunks.push(format!("[Attached file{name}{suffix}. {}", on_disk(&path)));
            }
            _ => {
                let original: Vec<u16> =
                    field(item, "text").unwrap_or_default().encode_utf16().collect();
                let mut text = original.clone();
                let mentions = item.get("mentions").and_then(Value::as_array);
                for mention in mentions.into_iter().flatten() {
                    let index = |key| mention.get(key).and_then(Value::as_u64).map(|n| n as usize);
                    let (Some(start), Some(end)) = (index("start"), index("end")) else {
                        continue;
                    };
                    let resource = mention.get("resource").unwrap_or(&Value::Null);
                    let is = |key: &str, want: &str| resource.get(key) == Some(&json!(want));
                    let name = resource.get("name").and_then(Value::as_str).unwrap_or_default();
                    let wanted: Vec<u16> = format!("${name}").encode_utf16().collect();
                    let slice = original.get(start.min(end)..end.min(original.len()));
                    let skill = is("kind", "command")
                        && is("source", "skill")
                        && is("trigger", "$")
                        && slice == Some(&wanted[..]);
                    if skill && start < text.len() {
                        text[start] = u16::from(b'/');
                    }
                }
                if !text.is_empty() {
                    chunks.push(String::from_utf16_lossy(&text));
                }
            }
        }
    }
    (!chunks.is_empty()).then(|| chunks.join("\n"))
}

/// The MCP `content` blocks for a bb tool response.
pub fn tool_content(response: &ToolCallResponse) -> Vec<Value> {
    let shown: Vec<&str> = response
        .content_items
        .iter()
        .map(|item| match item {
            ToolCallOutputItem::InputText { text } => text.as_str(),
            ToolCallOutputItem::InputImage { image_url } => image_url.as_str(),
        })
        .filter(|text| !text.is_empty())
        .collect();
    let fallback = if response.success { "OK" } else { "Tool call failed" };
    let blocks = if shown.is_empty() { vec![fallback] } else { shown };
    blocks.into_iter().map(|text| json!({"type": "text", "text": text})).collect()
}

/// `(tool, arguments, tool use id)`: forwards a bb dynamic tool call to the host.
pub type ToolCaller = Arc<
    dyn Fn(String, Value, Option<String>) -> BoxFuture<'static, RunnerResult<ToolCallResponse>>
        + Send
        + Sync,
>;

pub fn mcp_tools(tools: &[DynamicTool]) -> Vec<McpTool> {
    tools
        .iter()
        .map(|tool| {
            let object = tool.input_schema.get("type") == Some(&json!("object"));
            McpTool {
                name: tool.name.clone(),
                description: tool.description.clone(),
                input_schema: if object {
                    tool.input_schema.clone()
                } else {
                    json!({"type": "object"})
                },
            }
        })
        .collect()
}

/// The in-process `bb-bridge` MCP server for `spec.dynamicTools`.
pub fn bb_tool_server(tools: &[DynamicTool], call_tool: ToolCaller) -> McpServer {
    let names: Vec<String> = tools.iter().map(|tool| tool.name.clone()).collect();
    let call: McpCallTool = Arc::new(move |name: String, input: Value, use_id: Option<String>| {
        let known = names.contains(&name);
        let call_tool = call_tool.clone();
        Box::pin(async move {
            let failed = |text: String| ToolCallResponse::text(text, false);
            let response = if known {
                call_tool(name, input, use_id).await.unwrap_or_else(|error| failed(error.message))
            } else {
                failed(format!("Unknown tool: {name}"))
            };
            McpToolResult { content: tool_content(&response), is_error: !response.success }
        })
    });
    McpServer::new(BB_MCP_SERVER, mcp_tools(tools), call)
}

/// One entry of the initialize response's `models`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelInfo {
    pub value: String,
    pub display_name: String,
    pub description: String,
    pub supported_effort_levels: Option<Vec<Value>>,
    pub resolved_model: Option<String>,
}

const REASONING_DESCRIPTIONS: [(ReasoningLevel, &str); 8] = [
    (ReasoningLevel::None, "No extended thinking"),
    (ReasoningLevel::Low, "Low reasoning effort"),
    (ReasoningLevel::Medium, "Medium reasoning effort"),
    (ReasoningLevel::High, "High reasoning effort"),
    (ReasoningLevel::Xhigh, "Extra high reasoning effort"),
    (
        ReasoningLevel::Ultracode,
        "Extra high reasoning effort plus multi-agent workflow orchestration",
    ),
    (ReasoningLevel::Max, "Maximum reasoning effort"),
    (ReasoningLevel::Ultra, "Maximum reasoning with automatic task delegation"),
];

fn reasoning_efforts_for_levels(levels: &[ReasoningLevel]) -> Vec<ModelReasoningEffort> {
    levels
        .iter()
        .filter_map(|level| REASONING_DESCRIPTIONS.iter().find(|(known, _)| known == level))
        .map(|(level, description)| ModelReasoningEffort {
            reasoning_effort: *level,
            description: (*description).to_owned(),
        })
        .collect()
}

fn to_model(info: &ModelInfo, model: &str, name: String) -> AvailableModel {
    let levels: Vec<ReasoningLevel> = info
        .supported_effort_levels
        .iter()
        .flatten()
        .filter_map(|level| serde_json::from_value::<ReasoningLevel>(level.clone()).ok())
        .flat_map(|level| match level {
            ReasoningLevel::Xhigh => vec![ReasoningLevel::Xhigh, ReasoningLevel::Ultracode],
            other => vec![other],
        })
        .collect();
    let efforts = if levels.is_empty() { vec![ReasoningLevel::Low] } else { levels };
    let preferred = [ReasoningLevel::High, ReasoningLevel::Medium]
        .into_iter()
        .find(|level| efforts.contains(level));
    AvailableModel {
        id: model.to_owned(),
        model: model.to_owned(),
        display_name: name,
        route_provider_id: None,
        description: info.description.clone(),
        supported_reasoning_efforts: reasoning_efforts_for_levels(&efforts),
        default_reasoning_effort: preferred
            .or(efforts.first().copied())
            .unwrap_or(ReasoningLevel::Low),
        is_default: false,
    }
}

/// `Haiku 4.5`, `Opus 4 (1M)`, ... for a `claude-<family>-<major>[-<minor>]` id.
pub fn derived_model_name(model: &str) -> Option<String> {
    let captures = MODEL_ID.captures(model)?;
    let family = captures.get(1)?.as_str();
    let major = captures.get(2)?.as_str();
    let version = match captures.get(3) {
        Some(minor) => format!("{major}.{}", minor.as_str()),
        None => major.to_owned(),
    };
    let mut brand = family.chars();
    let brand = brand.next().map(|first| first.to_uppercase().chain(brand).collect::<String>());
    let large = if captures.get(4).is_some() { " (1M)" } else { "" };
    Some(format!("{} {version}{large}", brand.unwrap_or_default()))
}

pub fn build_models(discovered: &[ModelInfo]) -> ProviderModels {
    let is_default = |info: &ModelInfo| info.value == "default";
    let ordered = discovered
        .iter()
        .filter(|info| !is_default(info))
        .chain(discovered.iter().filter(|info| is_default(info)));
    let known =
        |list: &[AvailableModel], model: &str| list.iter().any(|entry| entry.model == model);
    let mut models: Vec<AvailableModel> = Vec::new();
    let mut aliases: Vec<AvailableModel> = Vec::new();
    for info in ordered {
        let model = info.resolved_model.clone().unwrap_or_else(|| info.value.clone());
        if known(&models, &model) {
            continue;
        }
        let name = derived_model_name(&model).unwrap_or_else(|| info.display_name.clone());
        models.push(to_model(info, &model, name));
    }
    for info in discovered {
        let alias = &info.value;
        if is_default(info) || known(&models, alias) || known(&aliases, alias) {
            continue;
        }
        aliases.push(to_model(info, alias, format!("{} alias", info.display_name)));
    }
    let resolved = discovered
        .iter()
        .find(|info| is_default(info))
        .and_then(|info| info.resolved_model.clone())
        .unwrap_or_default();
    let chosen = if known(&models, &resolved) {
        Some(resolved)
    } else {
        models.first().map(|model| model.model.clone())
    };
    for model in &mut models {
        model.is_default = Some(&model.model) == chosen.as_ref();
    }
    ProviderModels { models, selected_only_models: aliases }
}

/// Parses the initialize response's `models` array.
pub fn parse_models(models: &Value) -> Vec<ModelInfo> {
    models
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
        .collect()
}
