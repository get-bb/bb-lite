use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use bb_core::RunnerResult;
use bb_core::types::PermissionEscalation;
use bb_provider::Interaction;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::options::ClaudePermissionMode;
use crate::protocol::{CanUseToolRequest, PermissionDecision};
use crate::tools::parse_bash_command;

pub const INVALID_RESPONSE: &str = "Invalid interactive response payload";
pub const WORKSPACE_DENIAL: &str = "bb's workspace sandbox allows work inside the current workspace only. Stay inside the workspace or explain why extra access is needed.";
pub const USER_QUESTION_MAX_QUESTIONS: usize = 4;
pub const USER_QUESTION_MAX_OPTIONS: usize = 4;
const NETWORK_TOOLS: [&str; 3] = ["WebFetch", "WebSearch", "SandboxNetworkAccess"];
const READ_TOOLS: [&str; 4] = ["Read", "Grep", "Glob", "LS"];
const WRITE_TOOLS: [&str; 3] = ["Edit", "Write", "NotebookEdit"];

#[async_trait]
pub trait PermissionHost: Send + Sync {
    /// Resolves with the `PendingInteractionResolution` JSON.
    async fn request_interaction(&self, interaction: Interaction) -> RunnerResult<Value>;
    fn item_id(&self, tool_use_id: &str) -> String;
    fn turn_id(&self) -> Option<String>;
    fn mode(&self) -> ClaudePermissionMode;
    fn escalation(&self) -> PermissionEscalation;
}

/// The SDK `PermissionResult`, with optional fields exactly as the TypeScript adapter sets them.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "behavior", rename_all = "camelCase")]
pub enum PermissionResult {
    #[serde(rename_all = "camelCase")]
    Allow {
        updated_input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        decision_classification: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Vec<Value>>,
    },
    #[serde(rename_all = "camelCase")]
    Deny {
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        interrupt: bool,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        decision_classification: Option<String>,
    },
}

impl PermissionResult {
    fn deny(message: impl Into<String>) -> Self {
        Self::Deny { interrupt: false, message: message.into(), decision_classification: None }
    }

    fn allow(updated_input: Value, classification: Option<&str>) -> Self {
        Self::Allow {
            updated_input,
            decision_classification: classification.map(str::to_owned),
            updated_permissions: None,
        }
    }

    /// The `can_use_tool` response body, `toolUseID` included.
    pub fn to_response(&self, tool_use_id: Option<&str>) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or_else(|_| json!({}));
        if let (Some(id), Value::Object(object)) = (tool_use_id, &mut value) {
            object.insert("toolUseID".to_owned(), Value::String(id.to_owned()));
        }
        value
    }
}

/// Lossy: `PermissionDecision` always carries a classification, so a missing one becomes
/// `user_temporary` (allow) or `user_reject` (deny).
impl From<PermissionResult> for PermissionDecision {
    fn from(result: PermissionResult) -> Self {
        match result {
            PermissionResult::Allow {
                updated_input,
                decision_classification,
                updated_permissions,
            } => PermissionDecision::Allow {
                updated_input,
                updated_permissions,
                decision_classification: decision_classification
                    .unwrap_or_else(|| "user_temporary".to_owned()),
            },
            PermissionResult::Deny { interrupt, message, decision_classification } => {
                PermissionDecision::Deny {
                    message,
                    interrupt,
                    decision_classification: decision_classification
                        .unwrap_or_else(|| "user_reject".to_owned()),
                }
            }
        }
    }
}

fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    value?.as_array()?.iter().map(|item| item.as_str().map(str::to_owned)).collect()
}

/// The `PendingInteractionGrantablePermissionProfile` suggested by a request.
pub fn permission_profile(tool_name: &str, request: &CanUseToolRequest) -> Value {
    let suggestions = request.permission_suggestions.clone().unwrap_or_default();
    let valid = suggestions.iter().all(|entry| entry.get("type").is_some_and(Value::is_string));
    let parsed = if valid { suggestions } else { Vec::new() };
    let is_type = |entry: &Value, kind: &str| entry.get("type") == Some(&json!(kind));
    let suggested = parsed
        .iter()
        .filter(|entry| is_type(entry, "addDirectories"))
        .flat_map(|entry| strings(entry.get("directories")).unwrap_or_default());
    let directories = unique(suggested.chain(request.blocked_path.clone()));
    let read = if WRITE_TOOLS.contains(&tool_name) { vec![] } else { directories.clone() };
    let write = if READ_TOOLS.contains(&tool_name) { vec![] } else { directories.clone() };
    let rules = parsed.iter().any(|entry| is_type(entry, "addRules"));
    let network = NETWORK_TOOLS.contains(&tool_name) || rules;
    json!({
        "network": if network { json!({"enabled": true}) } else { Value::Null },
        "fileSystem": if directories.is_empty() { Value::Null } else { json!({"read": read, "write": write}) },
    })
}

/// SDK `PermissionUpdate`s granting `permissions` for the session.
pub fn session_updates(permissions: &Value, tool_name: Option<&str>) -> Option<Vec<Value>> {
    let file_system = permissions.get("fileSystem");
    let list = |key| strings(file_system.and_then(|fs| fs.get(key))).unwrap_or_default();
    let directories = unique(list("read").into_iter().chain(list("write")));
    let mut updates = Vec::new();
    if !directories.is_empty() {
        updates.push(
            json!({"type": "addDirectories", "directories": directories, "destination": "session"}),
        );
    }
    let network = permissions.pointer("/network/enabled") == Some(&Value::Bool(true));
    if let (Some(tool_name), true) = (tool_name, network) {
        let rules = json!([{"toolName": tool_name}]);
        updates.push(json!({"type": "addRules", "rules": rules, "behavior": "allow", "destination": "session"}));
    }
    (!updates.is_empty()).then_some(updates)
}

pub fn approval_payload(
    tool_name: &str,
    item_id: &str,
    input: &Value,
    reason: Option<&str>,
    permissions: &Value,
) -> Value {
    let path = input.get("file_path").filter(|v| !v.is_null()).or_else(|| input.get("path"));
    let path = path.and_then(Value::as_str);
    let grantable = session_updates(permissions, Some(tool_name)).is_some();
    let decisions: &[&str] = if grantable {
        &["allow_once", "allow_for_session", "deny"]
    } else {
        &["allow_once", "deny"]
    };
    let subject = match parse_bash_command(input).filter(|_| tool_name == "Bash") {
        Some(bash) => json!({
            "kind": "command",
            "itemId": item_id,
            "command": bash.command,
            "cwd": bash.cwd,
            "actions": [{"type": "unknown", "command": bash.command}],
            "sessionGrant": permissions,
        }),
        None if WRITE_TOOLS.contains(&tool_name) && path.is_some_and(|path| !path.is_empty()) => {
            json!({"kind": "file_change", "itemId": item_id, "writeScope": null, "sessionGrant": permissions})
        }
        None => json!({
            "kind": "permission_grant",
            "itemId": item_id,
            "toolName": tool_name,
            "permissions": permissions,
        }),
    };
    json!({"kind": "approval", "reason": reason, "availableDecisions": decisions, "subject": subject})
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value?.as_str().filter(|text| !text.is_empty()).map(str::to_owned)
}

/// Validates `AskUserQuestion` input as the zod schema does; `None` when invalid.
pub fn parse_questions(questions: Option<&Value>) -> Option<Vec<Value>> {
    let all = questions?.as_array()?;
    if all.is_empty() || all.len() > USER_QUESTION_MAX_QUESTIONS {
        return None;
    }
    let mut parsed = Vec::new();
    for question in all {
        let options = question.get("options")?.as_array()?;
        if options.len() < 2 || options.len() > USER_QUESTION_MAX_OPTIONS {
            return None;
        }
        let options = options
            .iter()
            .map(|option| {
                let label = non_empty(option.get("label"))?;
                Some(json!({"label": label, "description": non_empty(option.get("description"))?}))
            })
            .collect::<Option<Vec<_>>>()?;
        parsed.push(json!({
            "question": non_empty(question.get("question"))?,
            "header": non_empty(question.get("header"))?,
            "options": options,
            "multiSelect": question.get("multiSelect")?.as_bool()?,
        }));
    }
    let texts: HashSet<&Value> = parsed.iter().filter_map(|q| q.get("question")).collect();
    (texts.len() == parsed.len()).then_some(parsed)
}

pub fn question_payload(item_id: &str, questions: &[Value]) -> Value {
    let asked: Vec<Value> = questions
        .iter()
        .enumerate()
        .map(|(index, question)| {
            let id = format!("{item_id}:question-{}", index + 1);
            let empty = Vec::new();
            let options = question.get("options").and_then(Value::as_array).unwrap_or(&empty);
            let options: Vec<Value> = options
                .iter()
                .enumerate()
                .map(|(option_index, option)| {
                    json!({
                        "value": format!("{id}:option-{}", option_index + 1),
                        "label": option.get("label"),
                        "description": option.get("description"),
                    })
                })
                .collect();
            json!({
                "id": id,
                "prompt": question.get("question"),
                "shortLabel": question.get("header"),
                "multiSelect": question.get("multiSelect"),
                "options": options,
                "allowFreeText": true,
            })
        })
        .collect();
    json!({"kind": "user_question", "questions": asked})
}

/// The `AskUserQuestion` input with the user's answers, or `None` for an unusable resolution.
pub fn answered_input(payload: &Value, resolution: &Value) -> Option<Value> {
    if resolution.get("kind") != Some(&json!("user_answer")) {
        return None;
    }
    let empty = Vec::new();
    let questions = payload.get("questions").and_then(Value::as_array).unwrap_or(&empty);
    let mut answers = Map::new();
    let mut annotations = Map::new();
    let mut rebuilt = Vec::new();
    for question in questions {
        let id = question.get("id").and_then(Value::as_str).unwrap_or_default();
        let prompt = question.get("prompt").and_then(Value::as_str).unwrap_or_default();
        let options = question.get("options").and_then(Value::as_array).unwrap_or(&empty);
        let answer = resolution.get("answers").and_then(|answers| answers.get(id));
        let selected = answer.and_then(|a| a.get("selected")).and_then(Value::as_array);
        let labels = selected
            .unwrap_or(&empty)
            .iter()
            .map(|value| {
                let found = options.iter().find(|option| option.get("value") == Some(value));
                found.and_then(|option| option.get("label")).and_then(Value::as_str)
            })
            .collect::<Option<Vec<&str>>>()?;
        let chosen = labels.join(", ");
        let typed = answer.and_then(|a| a.get("freeText")).and_then(Value::as_str);
        let reply = match typed {
            Some(typed) if !chosen.is_empty() && !typed.is_empty() => format!("{chosen}; {typed}"),
            _ if !chosen.is_empty() => chosen.clone(),
            _ => typed.unwrap_or_default().to_owned(),
        };
        if reply.is_empty() {
            return None;
        }
        answers.insert(prompt.to_owned(), Value::String(reply));
        if let (false, Some(typed)) = (chosen.is_empty(), typed) {
            annotations.insert(prompt.to_owned(), json!({"notes": typed}));
        }
        let header =
            question.get("shortLabel").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| {
                let units: Vec<u16> = prompt.encode_utf16().take(12).collect();
                Value::String(String::from_utf16_lossy(&units))
            });
        let options: Vec<Value> = options
            .iter()
            .map(|option| {
                let label = option.get("label").cloned().unwrap_or(Value::Null);
                let description = option.get("description").filter(|v| !v.is_null()).cloned();
                json!({"label": label, "description": description.unwrap_or_else(|| label.clone())})
            })
            .collect();
        rebuilt.push(json!({
            "question": prompt,
            "header": header,
            "options": options,
            "multiSelect": question.get("multiSelect"),
        }));
    }
    let mut input = json!({"questions": rebuilt, "answers": answers});
    if let (false, Value::Object(map)) = (annotations.is_empty(), &mut input) {
        map.insert("annotations".to_owned(), Value::Object(annotations));
    }
    Some(input)
}

pub fn approval_result(
    payload: &Value,
    resolution: &Value,
    input: &Value,
) -> Option<PermissionResult> {
    let decision = resolution.get("decision")?;
    if decision == "deny" {
        return Some(PermissionResult::Deny {
            interrupt: false,
            message: "Permission request denied".to_owned(),
            decision_classification: Some("user_reject".to_owned()),
        });
    }
    if decision == "allow_once" {
        return Some(PermissionResult::allow(input.clone(), Some("user_temporary")));
    }
    let granted = resolution.get("grantedPermissions").filter(|v| !v.is_null())?;
    let subject = payload.get("subject");
    let kind = subject.and_then(|s| s.get("kind")).and_then(Value::as_str);
    let tool_name = match kind {
        Some("permission_grant") => subject.and_then(|s| s.get("toolName")).and_then(Value::as_str),
        Some("command") => Some("Bash"),
        _ => None,
    };
    Some(PermissionResult::Allow {
        updated_input: input.clone(),
        decision_classification: Some("user_permanent".to_owned()),
        updated_permissions: session_updates(granted, tool_name),
    })
}

/// Turns `can_use_tool` requests into host interactions and their resolutions into decisions.
pub struct ClaudePermissions {
    host: Arc<dyn PermissionHost>,
    pending: Mutex<Vec<(u64, oneshot::Sender<PermissionResult>)>>,
    next: Mutex<u64>,
}

impl ClaudePermissions {
    pub fn new(host: Arc<dyn PermissionHost>) -> Self {
        Self { host, pending: Mutex::new(Vec::new()), next: Mutex::new(0) }
    }

    /// Settles every open interaction with `{behavior:"deny", interrupt:true, message}`.
    pub fn cancel_pending(&self, message: &str) {
        for (_, settle) in self.pending.lock().drain(..) {
            let stopped = PermissionResult::Deny {
                interrupt: true,
                message: message.to_owned(),
                decision_classification: None,
            };
            let _ = settle.send(stopped);
        }
    }

    /// The decision for one request; `cancel` is the SDK's abort signal (`control_cancel_request`).
    /// Serialize with `to_response(request.tool_use_id)` to add `toolUseID`.
    pub async fn can_use_tool(
        &self,
        request: &CanUseToolRequest,
        cancel: CancellationToken,
    ) -> PermissionResult {
        tokio::task::yield_now().await;
        self.decide(request, cancel).await
    }

    async fn decide(
        &self,
        request: &CanUseToolRequest,
        cancel: CancellationToken,
    ) -> PermissionResult {
        let tool_name = request.tool_name.as_str();
        let input = &request.input;
        let tool_use_id = request.tool_use_id.clone().unwrap_or_default();
        if tool_name == "AskUserQuestion" {
            let Some(questions) = parse_questions(input.get("questions")) else {
                return PermissionResult::deny("Invalid AskUserQuestion input");
            };
            let payload = question_payload(&tool_use_id, &questions);
            let cancelled = "User question request cancelled";
            let resolution = match self.request(payload.clone(), cancel, cancelled).await {
                Ok(resolution) => resolution,
                Err(result) => return result,
            };
            return match answered_input(&payload, &resolution) {
                Some(updated_input) => PermissionResult::allow(updated_input, None),
                None => PermissionResult::deny(INVALID_RESPONSE),
            };
        }
        let unattended = self.host.escalation() == PermissionEscalation::Deny;
        let mode = self.host.mode();
        let escaping = input.get("dangerouslyDisableSandbox") == Some(&Value::Bool(true));
        let suggestions = request.permission_suggestions.as_ref().map_or(0, Vec::len);
        let asks =
            request.blocked_path.is_some() || request.decision_reason.is_some() || suggestions > 0;
        if tool_name == "Bash" && unattended && escaping {
            return PermissionResult::deny(WORKSPACE_DENIAL);
        }
        if !asks || mode == ClaudePermissionMode::BypassPermissions {
            return PermissionResult::allow(input.clone(), None);
        }
        if unattended {
            return PermissionResult::deny(
                request.decision_reason.as_deref().unwrap_or(WORKSPACE_DENIAL),
            );
        }
        let title = request.raw.get("title").and_then(Value::as_str).map(str::to_owned);
        let prompt = title.or_else(|| request.description.clone());
        let reason = request.decision_reason.clone().or(prompt);
        let profile = permission_profile(tool_name, request);
        let item_id = self.host.item_id(&tool_use_id);
        let payload = approval_payload(tool_name, &item_id, input, reason.as_deref(), &profile);
        let resolution =
            match self.request(payload.clone(), cancel, "Interactive request cancelled").await {
                Ok(resolution) => resolution,
                Err(result) => return result,
            };
        approval_result(&payload, &resolution, input)
            .unwrap_or_else(|| PermissionResult::deny(INVALID_RESPONSE))
    }

    async fn request(
        &self,
        payload: Value,
        cancel: CancellationToken,
        cancelled: &str,
    ) -> Result<Value, PermissionResult> {
        let (settle, settled) = oneshot::channel();
        let id = {
            let mut next = self.next.lock();
            *next += 1;
            *next
        };
        self.pending.lock().push((id, settle));
        let interaction = Interaction { payload, turn_id: self.host.turn_id() };
        let outcome = tokio::select! {
            result = self.host.request_interaction(interaction) => match result {
                Ok(resolution) => Ok(resolution),
                Err(error) => {
                    let message = if error.message.is_empty() { "Interactive request failed".to_owned() } else { error.message };
                    Err(PermissionResult::deny(message))
                }
            },
            () = cancel.cancelled() => Err(PermissionResult::deny(cancelled)),
            stopped = settled => Err(stopped.unwrap_or_else(|_| PermissionResult::deny(cancelled))),
        };
        self.pending.lock().retain(|(entry, _)| *entry != id);
        outcome
    }
}
