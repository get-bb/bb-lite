use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use bb_claude::interactions::*;
use bb_claude::options::ClaudePermissionMode;
use bb_claude::protocol::CanUseToolRequest;
use bb_core::types::PermissionEscalation;
use bb_core::{RunnerError, RunnerErrorCode, RunnerResult};
use bb_provider::Interaction;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

struct Host {
    answer: Option<Value>,
    asked: Mutex<Vec<Interaction>>,
    mode: ClaudePermissionMode,
    escalation: PermissionEscalation,
}

impl Host {
    fn new(answer: Option<Value>) -> Arc<Self> {
        Arc::new(Self {
            answer,
            asked: Mutex::new(vec![]),
            mode: ClaudePermissionMode::AcceptEdits,
            escalation: PermissionEscalation::Ask,
        })
    }
}

#[async_trait]
impl PermissionHost for Host {
    async fn request_interaction(&self, interaction: Interaction) -> RunnerResult<Value> {
        self.asked.lock().push(interaction);
        match &self.answer {
            Some(answer) => Ok(answer.clone()),
            None => futures::future::pending().await,
        }
    }
    fn item_id(&self, tool_use_id: &str) -> String {
        tool_use_id.to_owned()
    }
    fn turn_id(&self) -> Option<String> {
        Some("turn-1".into())
    }
    fn mode(&self) -> ClaudePermissionMode {
        self.mode
    }
    fn escalation(&self) -> PermissionEscalation {
        self.escalation
    }
}

fn request(tool: &str, input: Value, options: &Value) -> CanUseToolRequest {
    let text = |key: &str| options.get(key).and_then(Value::as_str).map(str::to_owned);
    CanUseToolRequest {
        tool_name: tool.into(),
        input,
        description: text("description"),
        permission_suggestions: options.get("suggestions").and_then(Value::as_array).cloned(),
        decision_reason: text("decisionReason"),
        blocked_path: text("blockedPath"),
        tool_use_id: text("toolUseID"),
        raw: options.clone(),
        ..CanUseToolRequest::default()
    }
}

fn step<'a>(steps: &'a [Value], key: &str) -> &'a Value {
    steps.iter().find_map(|step| step.get(key)).unwrap()
}

#[tokio::test]
async fn replays_sdk_fixtures() {
    for name in ["approval-allow", "approval-deny", "user-question"] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../../packages/runner/test/fixtures/claude/{name}.wire.ndjson"));
        let text = std::fs::read_to_string(path).unwrap();
        let steps: Vec<Value> =
            text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let permission = step(&steps, "permission");
        let host = Host::new(Some(step(&steps, "resolve").clone()));
        let permissions = ClaudePermissions::new(host.clone());
        let req = request(permission[0].as_str().unwrap(), permission[1].clone(), &permission[2]);
        let result = permissions.can_use_tool(&req, CancellationToken::new()).await;
        let asked = host.asked.lock().clone();
        assert_eq!(asked.len(), 1, "{name}");
        assert_eq!(asked[0].payload, *step(&steps, "interaction"), "{name} interaction");
        assert_eq!(asked[0].turn_id.as_deref(), Some("turn-1"));
        let decided = step(&steps, "decided");
        assert_eq!(decided["requestId"], permission[3]);
        assert_eq!(
            result.to_response(req.tool_use_id.as_deref()),
            decided["result"],
            "{name} decided"
        );
    }
}

fn bash(input: Value, options: Value) -> CanUseToolRequest {
    request("Bash", input, &options)
}

async fn decide(host: Arc<Host>, req: &CanUseToolRequest) -> Value {
    ClaudePermissions::new(host).can_use_tool(req, CancellationToken::new()).await.to_response(None)
}

#[tokio::test]
async fn auto_decisions() {
    let input = json!({"command": "ls"});
    let quiet = bash(input.clone(), json!({"toolUseID": "t"}));
    assert_eq!(
        decide(Host::new(None), &quiet).await,
        json!({"behavior": "allow", "updatedInput": input})
    );

    let asks = bash(input.clone(), json!({"toolUseID": "t", "decisionReason": "outside"}));
    let mut bypass = Host::new(None);
    Arc::get_mut(&mut bypass).unwrap().mode = ClaudePermissionMode::BypassPermissions;
    assert_eq!(decide(bypass, &asks).await["behavior"], "allow");

    let mut unattended = Host::new(None);
    Arc::get_mut(&mut unattended).unwrap().escalation = PermissionEscalation::Deny;
    assert_eq!(
        decide(unattended.clone(), &asks).await,
        json!({"behavior": "deny", "message": "outside"})
    );
    let blocked = bash(input.clone(), json!({"blockedPath": "/x"}));
    assert_eq!(decide(unattended.clone(), &blocked).await["message"], WORKSPACE_DENIAL);
    let escaping = bash(json!({"command": "ls", "dangerouslyDisableSandbox": true}), json!({}));
    assert_eq!(decide(unattended, &escaping).await["message"], WORKSPACE_DENIAL);

    let invalid = request("AskUserQuestion", json!({"questions": []}), &json!({}));
    assert_eq!(decide(Host::new(None), &invalid).await["message"], "Invalid AskUserQuestion input");
}

#[tokio::test]
async fn payload_kinds_and_session_grants() {
    let edit = request(
        "Edit",
        json!({"file_path": "/w/a.rs"}),
        &json!({"toolUseID": "t", "blockedPath": "/o/a.rs", "title": "Edit a.rs"}),
    );
    let grant = json!({"decision": "allow_for_session", "grantedPermissions": {"network": null, "fileSystem": {"read": [], "write": ["/o/a.rs"]}}});
    let host = Host::new(Some(grant));
    let result = decide(host.clone(), &edit).await;
    let payload = host.asked.lock()[0].payload.clone();
    assert_eq!(payload["reason"], "Edit a.rs");
    assert_eq!(
        payload["subject"],
        json!({"kind": "file_change", "itemId": "t", "writeScope": null,
        "sessionGrant": {"network": null, "fileSystem": {"read": [], "write": ["/o/a.rs"]}}})
    );
    assert_eq!(
        result,
        json!({"behavior": "allow", "updatedInput": {"file_path": "/w/a.rs"},
        "decisionClassification": "user_permanent",
        "updatedPermissions": [{"type": "addDirectories", "directories": ["/o/a.rs"], "destination": "session"}]})
    );

    let fetch = request("WebFetch", json!({"url": "u"}), &json!({"decisionReason": "net"}));
    let grant = json!({"decision": "allow_for_session", "grantedPermissions": {"network": {"enabled": true}, "fileSystem": null}});
    let host = Host::new(Some(grant));
    let result = decide(host.clone(), &fetch).await;
    let payload = host.asked.lock()[0].payload.clone();
    assert_eq!(payload["subject"]["kind"], "permission_grant");
    assert_eq!(payload["availableDecisions"], json!(["allow_once", "allow_for_session", "deny"]));
    assert_eq!(result["updatedPermissions"][0]["rules"], json!([{"toolName": "WebFetch"}]));

    let read = request("Read", json!({"file_path": "/r"}), &json!({"decisionReason": "r"}));
    let bad = Host::new(Some(json!({"decision": "allow_for_session", "grantedPermissions": null})));
    assert_eq!(decide(bad.clone(), &read).await["message"], INVALID_RESPONSE);
    assert_eq!(bad.asked.lock()[0].payload["availableDecisions"], json!(["allow_once", "deny"]));
}

#[tokio::test]
async fn question_answers_with_free_text() {
    let questions = json!([{"question": "Q?", "header": "H", "multiSelect": true,
        "options": [{"label": "a", "description": "A"}, {"label": "b", "description": "B"}]}]);
    let answer = json!({"kind": "user_answer", "answers": {"t:question-1": {"selected": ["t:question-1:option-1", "t:question-1:option-2"], "freeText": "more"}}});
    let req =
        request("AskUserQuestion", json!({"questions": questions}), &json!({"toolUseID": "t"}));
    let result = decide(Host::new(Some(answer)), &req).await;
    assert_eq!(result["updatedInput"]["answers"], json!({"Q?": "a, b; more"}));
    assert_eq!(result["updatedInput"]["annotations"], json!({"Q?": {"notes": "more"}}));
    let wrong = json!({"decision": "allow_once"});
    assert_eq!(decide(Host::new(Some(wrong)), &req).await["message"], INVALID_RESPONSE);
}

#[tokio::test]
async fn cancellation_and_failures() {
    let req = bash(json!({"command": "ls"}), json!({"decisionReason": "x"}));
    let permissions = Arc::new(ClaudePermissions::new(Host::new(None)));
    let token = CancellationToken::new();
    let running = tokio::spawn({
        let (permissions, req, token) = (permissions.clone(), req.clone(), token.clone());
        async move { permissions.can_use_tool(&req, token).await.to_response(None) }
    });
    tokio::task::yield_now().await;
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    permissions.cancel_pending("Turn stopped");
    assert_eq!(
        running.await.unwrap(),
        json!({"behavior": "deny", "interrupt": true, "message": "Turn stopped"})
    );
    let token2 = CancellationToken::new();
    token2.cancel();
    let result = permissions.can_use_tool(&req, token2).await.to_response(None);
    assert_eq!(result["message"], "Interactive request cancelled");

    struct Failing;
    #[async_trait]
    impl PermissionHost for Failing {
        async fn request_interaction(&self, _: Interaction) -> RunnerResult<Value> {
            Err(RunnerError::new(RunnerErrorCode::MissingExecutable, ""))
        }
        fn item_id(&self, id: &str) -> String {
            id.into()
        }
        fn turn_id(&self) -> Option<String> {
            None
        }
        fn mode(&self) -> ClaudePermissionMode {
            ClaudePermissionMode::AcceptEdits
        }
        fn escalation(&self) -> PermissionEscalation {
            PermissionEscalation::Ask
        }
    }
    let failing = ClaudePermissions::new(Arc::new(Failing));
    let result = failing.can_use_tool(&req, CancellationToken::new()).await.to_response(None);
    assert_eq!(result["message"], "Interactive request failed");
}
