mod replay;

use std::time::Duration;

use bb_claude::protocol::ChildExit;
use replay::{Outcome, fixture, replay};
use serde_json::{Value, json};

fn recorded_exit(scenario: &str) -> ChildExit {
    let exit: Value = serde_json::from_str(&fixture(scenario, "exit.json")).unwrap();
    ChildExit {
        code: exit["code"].as_i64().map(|code| code as i32),
        signal: exit["signal"].as_str().map(str::to_owned),
        error: None,
    }
}

async fn finish(scenario: &str, outcome: &Outcome) {
    outcome.scripted.finish(recorded_exit(scenario));
    tokio::time::timeout(Duration::from_secs(5), outcome.client.wait_exit()).await.unwrap();
    let exits = outcome.recorder.exits.lock().clone();
    assert_eq!(exits.len(), 1, "{scenario}: on_exit once");
    assert_eq!(exits[0].code, recorded_exit(scenario).code);
}

fn no_control_messages(outcome: &Outcome) {
    for message in outcome.recorder.messages.lock().iter() {
        let kind = message["type"].as_str().unwrap_or_default();
        assert!(!kind.starts_with("control_"), "control message leaked: {message}");
    }
}

fn last_control(outcome: &Outcome, subtype: &str) -> Value {
    outcome.control_results.iter().rev().find(|(name, _)| name == subtype).unwrap().1.clone()
}

#[tokio::test]
async fn simple_replays() {
    let outcome = replay("simple", false).await;
    let initialize = last_control(&outcome, "initialize");
    assert!(initialize["models"].is_array());
    assert_eq!(last_control(&outcome, "interrupt"), json!({"still_queued": []}));
    let kinds: Vec<String> = outcome
        .recorder
        .messages
        .lock()
        .iter()
        .map(|message| message["type"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(kinds.last().map(String::as_str), Some("command_lifecycle"));
    assert!(kinds.iter().any(|kind| kind == "result"));
    no_control_messages(&outcome);
    finish("simple", &outcome).await;
}

#[tokio::test]
async fn approval_allow_replays() {
    let outcome = replay("approval-allow", false).await;
    let hooks = outcome.recorder.hooks.lock().clone();
    assert_eq!(hooks.len(), 1);
    assert_eq!(hooks[0].0, "hook_0");
    assert_eq!(hooks[0].2.as_deref(), Some("toolu_01DSyXcrzF4mnfavMR3EUuKi"));
    assert_eq!(hooks[0].1["tool_name"], "Bash");
    let permissions = outcome.recorder.permissions.lock().clone();
    assert_eq!(permissions.len(), 1);
    assert_eq!(permissions[0].tool_name, "Bash");
    assert_eq!(permissions[0].decision_reason.as_deref(), Some("This command requires approval"));
    let response = outcome
        .written
        .iter()
        .find(|line| line["response"]["response"]["behavior"].is_string())
        .unwrap();
    assert_eq!(
        response.to_string(),
        r#"{"type":"control_response","response":{"subtype":"success","request_id":"f5faefed-1cdb-4cad-ad97-c7c9381e8c23","response":{"behavior":"allow","updatedInput":{"command":"python3 -c 'print(1+1)'","description":"Run simple Python arithmetic"},"decisionClassification":"user_temporary","toolUseID":"toolu_01DSyXcrzF4mnfavMR3EUuKi"}}}"#
    );
    no_control_messages(&outcome);
    finish("approval-allow", &outcome).await;
}

#[tokio::test]
async fn approval_deny_replays() {
    let outcome = replay("approval-deny", true).await;
    let response = outcome
        .written
        .iter()
        .find(|line| line["response"]["response"]["behavior"].is_string())
        .unwrap();
    assert_eq!(
        response.to_string(),
        r#"{"type":"control_response","response":{"subtype":"success","request_id":"bb6bf590-708d-4775-ad0a-f042981a8067","response":{"behavior":"deny","message":"Permission request denied","decisionClassification":"user_reject","toolUseID":"toolu_01ThwHBJB8DhExhEXcAAzeie"}}}"#
    );
    no_control_messages(&outcome);
    finish("approval-deny", &outcome).await;
}

#[tokio::test]
async fn dynamic_tool_replays() {
    let outcome = replay("dynamic-tool", false).await;
    let mcp: Vec<String> = outcome
        .written
        .iter()
        .filter_map(|line| line["response"]["response"].get("mcp_response"))
        .map(Value::to_string)
        .collect();
    assert_eq!(
        mcp,
        vec![
            r#"{"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"bb-bridge","version":"1.0.0"}},"jsonrpc":"2.0","id":0}"#,
            r#"{"jsonrpc":"2.0","result":{},"id":0}"#,
            r#"{"result":{"tools":[{"name":"lookup","description":"Look up a value","inputSchema":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}}]},"jsonrpc":"2.0","id":1}"#,
            r#"{"result":{"content":[{"type":"text","text":"value-of-a=42"}]},"jsonrpc":"2.0","id":2}"#,
        ]
    );
    assert_eq!(outcome.recorder.hooks.lock().len(), 2);
    no_control_messages(&outcome);
    finish("dynamic-tool", &outcome).await;
}

#[tokio::test]
async fn interrupt_replays() {
    let outcome = replay("interrupt", false).await;
    assert_eq!(last_control(&outcome, "interrupt"), json!({"still_queued": []}));
    let messages = outcome.recorder.messages.lock().clone();
    let result = messages.iter().rev().find(|message| message["type"] == "result").unwrap();
    assert_eq!(result["subtype"], "error_during_execution");
    assert!(messages.iter().any(|message| {
        message["type"] == "user"
            && message["message"]["content"][0]["text"] == "[Request interrupted by user]"
    }));
    finish("interrupt", &outcome).await;
    assert_eq!(outcome.recorder.exits.lock()[0].code, Some(1));
}

#[tokio::test]
async fn other_recordings_replay() {
    for scenario in ["interrupt/spawn-2", "steer", "resume", "tool-auto-approved"] {
        let outcome = replay(scenario, false).await;
        no_control_messages(&outcome);
        finish(scenario, &outcome).await;
    }
}
