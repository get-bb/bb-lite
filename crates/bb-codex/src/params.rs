use std::path::{Component, Path, PathBuf};

use bb_core::env::EnvMap;
use bb_core::{
    AvailableModel, ExecutionOptions, ModelReasoningEffort, PermissionEscalation, PermissionMode,
    ReasoningLevel, RunnerError, RunnerResult, ServiceTier, SessionSpec,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

pub const POOL_URL: &str = "CODEX_OPENAI_BASE_URL";
pub const POOL_TOKEN: &str = "CODEX_POOL_AUTH_TOKEN";
pub const PERMISSIONS_REQUEST: &str = "item/permissions/requestApproval";
pub const FILE_CHANGE_REQUEST: &str = "item/fileChange/requestApproval";
const EVERY: [&str; 3] = ["allow_once", "allow_for_session", "deny"];

pub fn pool_args(env: &EnvMap) -> Vec<String> {
    let url = env.get(POOL_URL).filter(|url| !url.is_empty());
    let token = env.get(POOL_TOKEN).filter(|token| !token.is_empty());
    let (Some(url), Some(_)) = (url, token) else { return Vec::new() };
    let quoted = Value::String(url.clone()).to_string();
    let provider = "model_providers.bb-account-pool";
    let overrides = [
        format!("openai_base_url={quoted}"),
        "model_provider=\"bb-account-pool\"".to_owned(),
        format!("{provider}.name=\"OpenAI\""),
        format!("{provider}.base_url={quoted}"),
        format!("{provider}.wire_api=\"responses\""),
        format!("{provider}.requires_openai_auth=true"),
        format!("{provider}.supports_websockets=false"),
        format!("{provider}.env_http_headers.x-bb-account-pool-token=\"{POOL_TOKEN}\""),
    ];
    overrides.into_iter().flat_map(|value| ["-c".to_owned(), value]).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PermissionSettings {
    pub approval_policy: &'static str,
    pub approvals_reviewer: &'static str,
    pub sandbox: &'static str,
}

impl PermissionSettings {
    /// `{approvalPolicy, approvalsReviewer}` as spread into `turn/start`.
    pub fn approval_json(&self, into: &mut Map<String, Value>) {
        into.insert("approvalPolicy".into(), self.approval_policy.into());
        into.insert("approvalsReviewer".into(), self.approvals_reviewer.into());
    }

    pub fn sandboxed(&self) -> bool {
        self.sandbox == "workspace-write"
    }
}

pub fn permission_settings(options: &ExecutionOptions) -> PermissionSettings {
    if options.permission_mode == PermissionMode::Full {
        return PermissionSettings {
            approval_policy: "never",
            approvals_reviewer: "user",
            sandbox: "danger-full-access",
        };
    }
    let automatic = options.permission_mode == PermissionMode::Auto;
    let unattended = options.permission_escalation == PermissionEscalation::Deny && !automatic;
    PermissionSettings {
        approval_policy: if unattended { "never" } else { "on-request" },
        approvals_reviewer: if automatic { "auto_review" } else { "user" },
        sandbox: "workspace-write",
    }
}

pub fn sandbox_policy(options: &ExecutionOptions, roots: &[String]) -> Value {
    if options.permission_mode == PermissionMode::Full {
        return json!({"type": "dangerFullAccess"});
    }
    json!({
        "type": "workspaceWrite",
        "writableRoots": roots,
        "networkAccess": true,
        "excludeTmpdirEnvVar": false,
        "excludeSlashTmp": false,
    })
}

pub fn reasoning_effort(options: &ExecutionOptions) -> RunnerResult<&'static str> {
    let level = options.reasoning_level;
    if !matches!(level, ReasoningLevel::None | ReasoningLevel::Ultracode) {
        return Ok(level.as_str());
    }
    let message = format!("Codex does not support the {} reasoning level.", level.as_str());
    Err(RunnerError::failed(message))
}

/// `"fast"` or JSON `null`.
pub fn service_tier(options: &ExecutionOptions) -> Value {
    if options.service_tier == ServiceTier::Fast { "fast".into() } else { Value::Null }
}

pub fn to_codex_input(input: &[Value]) -> Vec<Value> {
    input
        .iter()
        .map(|chunk| {
            let kind = chunk.get("type").cloned().unwrap_or(Value::Null);
            match kind.as_str() {
                Some("image") => json!({"type": kind, "url": chunk.get("url")}),
                Some("text") | Some("localFile") => {
                    let body = if kind == "text" {
                        chunk.get("text").cloned().unwrap_or(Value::Null)
                    } else {
                        match chunk.get("path") {
                            Some(path) => {
                                let path =
                                    path.as_str().map_or_else(|| path.to_string(), str::to_owned);
                                Value::String(format!("[Attached file: {path}]"))
                            }
                            None => Value::String(String::new()),
                        }
                    };
                    json!({"type": "text", "text": body, "text_elements": []})
                }
                _ => json!({"type": kind, "path": chunk.get("path")}),
            }
        })
        .collect()
}

fn resolve(base: &Path, path: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in base.join(path).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

async fn read_trimmed(path: &Path) -> std::io::Result<String> {
    Ok(tokio::fs::read_to_string(path).await?.trim().to_owned())
}

fn is_ref(text: &str) -> bool {
    text.starts_with("refs/")
        && text.len() > 5
        && text.chars().all(|c| c.is_ascii_alphanumeric() || "_./-".contains(c))
}

/// The linked worktree's git directory plus the shared objects and ref directories its branch
/// writes to, or nothing when `cwd` is not a linked worktree.
pub async fn git_writable_roots(cwd: &str) -> Vec<String> {
    linked_roots(cwd).await.unwrap_or_default()
}

async fn linked_roots(cwd: &str) -> std::io::Result<Vec<String>> {
    let workspace = tokio::fs::canonicalize(cwd).await?;
    let git_file = workspace.join(".git");
    let pointer = read_trimmed(&git_file).await?;
    let pointer = pointer.lines().find_map(|line| {
        let rest = line.strip_prefix("gitdir:")?;
        let rest = rest.trim();
        (!rest.is_empty()).then(|| rest.to_owned())
    });
    let Some(pointer) = pointer else { return Ok(Vec::new()) };
    let git_dir = tokio::fs::canonicalize(resolve(&workspace, &pointer)).await?;
    let backlink = resolve(&git_dir, &read_trimmed(&git_dir.join("gitdir")).await?);
    let common_pointer = read_trimmed(&git_dir.join("commondir")).await?;
    let common = tokio::fs::canonicalize(resolve(&git_dir, &common_pointer)).await?;
    let worktrees = format!("{}/", common.join("worktrees").display());
    let linked = git_dir.display().to_string().starts_with(&worktrees);
    if backlink != git_file || !linked {
        return Ok(Vec::new());
    }
    let head = read_trimmed(&git_dir.join("HEAD")).await?;
    let reference = head.strip_prefix("ref:").map(str::trim).filter(|text| is_ref(text));
    let ref_dir = match reference {
        Some(reference) if !reference.contains("..") => Path::new(reference)
            .parent()
            .map_or_else(|| ".".to_owned(), |dir| dir.display().to_string()),
        _ => "refs/heads".to_owned(),
    };
    let candidates = ["objects".to_owned(), ref_dir.clone(), format!("logs/{ref_dir}")];
    let prefix = format!("{}/", common.display());
    let mut roots = vec![git_dir.display().to_string()];
    for candidate in candidates {
        let resolved = tokio::fs::canonicalize(common.join(candidate)).await;
        let resolved = resolved.map(|path| path.display().to_string()).unwrap_or_default();
        if resolved.starts_with(&prefix) {
            roots.push(resolved);
        }
    }
    Ok(roots)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOptions {
    pub memory_enabled: Option<bool>,
    pub provider_subagents_enabled: Option<bool>,
    pub additional_workspace_write_roots: Option<Vec<String>>,
}

pub fn provider_options(options: &ExecutionOptions) -> RunnerResult<ProviderOptions> {
    Ok(serde_json::from_value(Value::Object(options.provider_options.clone()))?)
}

pub fn initialize_params() -> Value {
    json!({
        "clientInfo": {"name": "bb", "version": "1.0.0", "title": null},
        "capabilities": {"experimentalApi": true},
    })
}

/// The parameters `thread/start` and `thread/resume` share. `env` is the session host's
/// environment; `roots` are the writable roots (empty unless sandboxed).
pub fn construction_params(
    spec: &SessionSpec,
    options: &ExecutionOptions,
    env: &EnvMap,
    roots: &[String],
) -> RunnerResult<Map<String, Value>> {
    let permissions = permission_settings(options);
    let custom = provider_options(options)?;
    let memory = custom.memory_enabled.unwrap_or(true);
    let prefix = "shell_environment_policy.set";
    let mut config = Map::new();
    config.insert(format!("{prefix}.BB_THREAD_ID"), spec.thread_id.clone().into());
    for (name, value) in env {
        config.insert(format!("{prefix}.{name}"), value.clone().into());
    }
    config.insert("model_reasoning_effort".into(), reasoning_effort(options)?.into());
    config.insert("features.default_mode_request_user_input".into(), false.into());
    if custom.provider_subagents_enabled == Some(false) {
        config.insert("features.multi_agent".into(), false.into());
        let threads = "features.multi_agent_v2.max_concurrent_threads_per_session";
        config.insert(threads.into(), 1.into());
    }
    config.insert("memories.use_memories".into(), memory.into());
    config.insert("memories.generate_memories".into(), memory.into());
    if !roots.is_empty() {
        config.insert("sandbox_workspace_write.writable_roots".into(), json!(roots));
    }
    let mut params = Map::new();
    permissions.approval_json(&mut params);
    params.insert("sandbox".into(), permissions.sandbox.into());
    params.insert("cwd".into(), spec.cwd.clone().into());
    let instructions = spec.instructions.trim();
    if !instructions.is_empty() {
        params.insert("developerInstructions".into(), instructions.into());
    }
    if !options.model.is_empty() {
        params.insert("model".into(), options.model.clone().into());
    }
    params.insert("serviceTier".into(), service_tier(options));
    params.insert("config".into(), Value::Object(config));
    if !spec.dynamic_tools.is_empty() {
        let tools = spec.dynamic_tools.iter().map(|tool| {
            json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.input_schema,
            })
        });
        params.insert("dynamicTools".into(), tools.collect());
    }
    Ok(params)
}

pub fn thread_start_params(shared: Map<String, Value>) -> Value {
    let mut params = shared;
    params.insert("ephemeral".into(), false.into());
    Value::Object(params)
}

pub fn thread_resume_params(thread_id: &str, shared: Map<String, Value>) -> Value {
    let mut params = Map::new();
    params.insert("threadId".into(), thread_id.into());
    params.insert("excludeTurns".into(), true.into());
    params.extend(shared);
    Value::Object(params)
}

pub fn turn_start_params(
    thread_id: &str,
    input: &[Value],
    options: &ExecutionOptions,
    roots: &[String],
) -> RunnerResult<Value> {
    let mut params = Map::new();
    params.insert("threadId".into(), thread_id.into());
    params.insert("input".into(), to_codex_input(input).into());
    permission_settings(options).approval_json(&mut params);
    params.insert("sandboxPolicy".into(), sandbox_policy(options, roots));
    if !options.model.is_empty() {
        params.insert("model".into(), options.model.clone().into());
    }
    params.insert("serviceTier".into(), service_tier(options));
    params.insert("effort".into(), reasoning_effort(options)?.into());
    Ok(Value::Object(params))
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct NetworkGrant {
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct FileSystemGrant {
    pub read: Option<Vec<String>>,
    pub write: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsGrant {
    #[serde(default)]
    pub network: Option<NetworkGrant>,
    #[serde(default)]
    pub file_system: Option<FileSystemGrant>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub turn_id: String,
    pub item_id: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub command_actions: Option<Vec<Value>>,
    #[serde(default)]
    pub additional_permissions: Option<PermissionsGrant>,
    #[serde(default)]
    pub available_decisions: Option<Vec<Value>>,
    #[serde(default)]
    pub grant_root: Option<String>,
    #[serde(default)]
    pub permissions: Option<PermissionsGrant>,
}

pub fn parse_approval(params: &Value) -> RunnerResult<ApprovalRequest> {
    Ok(ApprovalRequest::deserialize(params)?)
}

fn profile(grant: Option<&PermissionsGrant>) -> Value {
    let network = grant.and_then(|grant| grant.network.as_ref());
    let network = network.map_or(Value::Null, |network| json!({"enabled": network.enabled}));
    let files = grant.and_then(|grant| grant.file_system.as_ref());
    let files = files.map_or(Value::Null, |files| {
        json!({
            "read": files.read.clone().unwrap_or_default(),
            "write": files.write.clone().unwrap_or_default(),
        })
    });
    json!({"network": network, "fileSystem": files})
}

fn command_action(action: &Value) -> Option<Value> {
    let text = |key: &str| action.get(key)?.as_str().map(|text| Value::String(text.to_owned()));
    let nullable = |key: &str| match action.get(key)? {
        Value::Null => Some(Value::Null),
        Value::String(text) => Some(text.clone().into()),
        _ => None,
    };
    let command = text("command")?;
    Some(match action.get("type")?.as_str()? {
        "read" => {
            json!({"type": "read", "command": command, "name": text("name")?, "path": text("path")?})
        }
        "listFiles" => json!({"type": "listFiles", "command": command, "path": nullable("path")?}),
        "search" => json!({
            "type": "search",
            "command": command,
            "query": nullable("query")?,
            "path": nullable("path")?,
        }),
        "unknown" => json!({"type": "unknown", "command": command}),
        _ => return None,
    })
}

/// Turns a codex `item/*/requestApproval` request into a pending interaction payload.
pub fn decode_approval(method: &str, params: &Value) -> RunnerResult<Value> {
    let request = parse_approval(params)?;
    let item_id = request.item_id.clone();
    let reason = request.reason.clone();
    let payload = |subject: Value, decisions: Vec<&str>| json!({"kind": "approval", "reason": reason, "subject": subject, "availableDecisions": decisions});
    if method == PERMISSIONS_REQUEST {
        let permissions = profile(request.permissions.as_ref());
        let subject = json!({
            "kind": "permission_grant",
            "itemId": item_id,
            "permissions": permissions,
            "toolName": null,
        });
        return Ok(payload(subject, EVERY.to_vec()));
    }
    if method == FILE_CHANGE_REQUEST {
        let write_scope = request.grant_root.clone().filter(|root| !root.is_empty());
        let session_grant = write_scope.as_ref().map_or(
            Value::Null,
            |scope| json!({"network": null, "fileSystem": {"read": [], "write": [scope]}}),
        );
        let decisions = if write_scope.is_some() {
            EVERY.to_vec()
        } else {
            EVERY.into_iter().filter(|decision| *decision != "allow_for_session").collect()
        };
        let subject = json!({
            "kind": "file_change",
            "itemId": item_id,
            "writeScope": write_scope,
            "sessionGrant": session_grant,
        });
        return Ok(payload(subject, decisions));
    }
    let Some(command) = request.command.clone().filter(|command| !command.is_empty()) else {
        return Err(RunnerError::failed("Command approval request has no command"));
    };
    let grant = profile(request.additional_permissions.as_ref());
    let files =
        request.additional_permissions.as_ref().and_then(|grant| grant.file_system.as_ref());
    let any_file = files.is_some_and(|files| {
        let lists = [files.read.as_deref(), files.write.as_deref()];
        lists.into_iter().flatten().flatten().any(|path| !path.is_empty())
    });
    let grantable = grant["network"]["enabled"] == Value::Bool(true) || any_file;
    let offered: Vec<&str> = match &request.available_decisions {
        Some(list) => list
            .iter()
            .filter_map(|decision| match decision.as_str()? {
                "accept" => Some("allow_once"),
                "acceptForSession" => Some("allow_for_session"),
                "decline" | "cancel" => Some("deny"),
                _ => None,
            })
            .collect(),
        None => EVERY.to_vec(),
    };
    let mut decisions: Vec<&str> = Vec::new();
    for decision in offered {
        let usable = grantable || decision != "allow_for_session";
        if usable && !decisions.contains(&decision) {
            decisions.push(decision);
        }
    }
    if decisions.is_empty() {
        return Err(RunnerError::failed("Command approval request offers no usable decision"));
    }
    let actions: Vec<Value> =
        request.command_actions.iter().flatten().filter_map(command_action).collect();
    let subject = json!({
        "kind": "command",
        "itemId": item_id,
        "command": command,
        "cwd": request.cwd,
        "actions": actions,
        "sessionGrant": if grantable { grant } else { Value::Null },
    });
    Ok(payload(subject, decisions))
}

/// Turns a pending interaction resolution into the codex approval response.
pub fn encode_approval(method: &str, resolution: &Value) -> Value {
    let decision = resolution.get("decision").and_then(Value::as_str).unwrap_or("deny");
    if method != PERMISSIONS_REQUEST {
        let encoded = match decision {
            "allow_once" => json!("accept"),
            "allow_for_session" => json!("acceptForSession"),
            "deny" => json!("decline"),
            _ => Value::Null,
        };
        return json!({"decision": encoded});
    }
    let granted = resolution.get("grantedPermissions").filter(|granted| !granted.is_null());
    let Some(granted) = granted.filter(|_| decision != "deny") else {
        return json!({"permissions": {}, "scope": "turn"});
    };
    let list = |entries: Option<&Value>| match entries.and_then(Value::as_array) {
        Some(entries) if !entries.is_empty() => Value::Array(entries.clone()),
        _ => Value::Null,
    };
    let mut permissions = Map::new();
    if let Some(network) = granted.get("network").filter(|network| truthy(network)) {
        let enabled = network.get("enabled").cloned().unwrap_or(Value::Null);
        permissions.insert("network".into(), json!({"enabled": enabled}));
    }
    if let Some(files) = granted.get("fileSystem").filter(|files| truthy(files)) {
        let access = json!({"read": list(files.get("read")), "write": list(files.get("write"))});
        permissions.insert("fileSystem".into(), access);
    }
    let scope = if decision == "allow_for_session" { "session" } else { "turn" };
    json!({"permissions": permissions, "scope": scope})
}

fn truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false))
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

pub fn reasoning_efforts_for_levels(levels: &[ReasoningLevel]) -> Vec<ModelReasoningEffort> {
    levels
        .iter()
        .map(|level| ModelReasoningEffort {
            reasoning_effort: *level,
            description: REASONING_DESCRIPTIONS[level.rank()].1.to_owned(),
        })
        .collect()
}

fn optional_text(entry: &Value, key: &str, min: usize) -> Result<Option<String>, ()> {
    match entry.get(key) {
        None => Ok(None),
        Some(Value::String(text)) if text.chars().count() >= min => Ok(Some(text.clone())),
        Some(_) => Err(()),
    }
}

fn parse_model(entry: &Value) -> Result<AvailableModel, ()> {
    if !entry.is_object() {
        return Err(());
    }
    let id = optional_text(entry, "id", 1)?.ok_or(())?;
    let model = optional_text(entry, "model", 1)?.ok_or(())?;
    let display_name = optional_text(entry, "displayName", 1)?;
    let description = optional_text(entry, "description", 0)?;
    let efforts = match entry.get("supportedReasoningEfforts") {
        None => Vec::new(),
        Some(Value::Array(efforts)) => efforts.clone(),
        Some(_) => return Err(()),
    };
    let is_default = match entry.get("isDefault") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(()),
    };
    let mut supported: Vec<ReasoningLevel> = Vec::new();
    for effort in &efforts {
        let level = effort.get("reasoningEffort").and_then(Value::as_str);
        if let Some(level) = level.and_then(ReasoningLevel::parse)
            && !supported.contains(&level)
        {
            supported.push(level);
        }
    }
    if supported.is_empty() {
        supported = vec![
            ReasoningLevel::Low,
            ReasoningLevel::Medium,
            ReasoningLevel::High,
            ReasoningLevel::Xhigh,
        ];
    }
    let preferred = entry.get("defaultReasoningEffort").and_then(Value::as_str);
    let preferred =
        preferred.and_then(ReasoningLevel::parse).filter(|level| supported.contains(level));
    Ok(AvailableModel {
        display_name: display_name.unwrap_or_else(|| model.clone()),
        id,
        model,
        route_provider_id: None,
        description: description.unwrap_or_default(),
        supported_reasoning_efforts: reasoning_efforts_for_levels(&supported),
        default_reasoning_effort: preferred.unwrap_or(supported[0]),
        is_default,
    })
}

/// Parses a `model/list` result; entries that do not match the model shape are skipped.
pub fn parse_models(result: &Value) -> RunnerResult<Vec<AvailableModel>> {
    let Some(data) = result.get("data").and_then(Value::as_array) else {
        return Err(RunnerError::failed("Invalid codex model list: expected a data array"));
    };
    Ok(data.iter().filter_map(|entry| parse_model(entry).ok()).collect())
}

#[cfg(test)]
#[path = "params_tests.rs"]
mod tests;
