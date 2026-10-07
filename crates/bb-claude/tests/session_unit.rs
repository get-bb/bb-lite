mod replay;

use std::sync::Arc;

use async_trait::async_trait;
use bb_claude::protocol::ChildExit;
use bb_claude::session::{
    ClaudeAdapterOptions, SUBAGENTS_OFF, SpawnClaude, WORKFLOWS_OFF, create_claude_adapter,
};
use bb_core::env::EnvMap;
use bb_core::{ExecutionOptions, RunnerResult, SessionSpec, ToolCallResponse};
use bb_provider::{
    EventBuilder, ExitInfo, Interaction, ProviderSession, SessionHost, SessionHostCallbacks,
    SteerInput, SteerOutcome, ToolCall,
};
use parking_lot::Mutex;
use replay::{Scripted, scripted_child};
use serde_json::{Value, json};
use tokio::sync::mpsc;

#[derive(Default)]
struct Host {
    exits: Mutex<Vec<ExitInfo>>,
}

#[async_trait]
impl SessionHostCallbacks for Host {
    async fn call_tool(&self, _call: ToolCall) -> RunnerResult<ToolCallResponse> {
        Err(bb_core::RunnerError::failed("unused"))
    }

    async fn request_interaction(&self, _interaction: Interaction) -> RunnerResult<Value> {
        Ok(json!({"decision": "deny"}))
    }

    fn on_exit(&self, info: ExitInfo) {
        self.exits.lock().push(info);
    }
}

fn options(provider_options: Value) -> ExecutionOptions {
    serde_json::from_value(json!({
        "model": "claude-haiku-4-5", "reasoningLevel": "low", "serviceTier": "default",
        "permissionMode": "accept-edits", "permissionEscalation": "ask",
        "providerOptions": provider_options
    }))
    .expect("options")
}

fn spec(cwd: &str) -> SessionSpec {
    serde_json::from_value(json!({
        "threadId": "thr_1", "providerId": "claude-code", "cwd": cwd, "providerThreadId": null,
        "instructions": "", "dynamicTools": [], "env": {}, "skillDirs": []
    }))
    .expect("spec")
}

async fn open(provider_options: Value) -> (Arc<dyn ProviderSession>, Scripted, Arc<Host>) {
    let (sender, mut children) = mpsc::unbounded_channel::<Scripted>();
    let spawn: SpawnClaude = Arc::new(move |_: &str, _: &[String], _: &str, _: &EnvMap| {
        let (child, scripted) = scripted_child();
        let _ = sender.send(scripted);
        child
    });
    let adapter = create_claude_adapter(ClaudeAdapterOptions {
        spawn: Some(spawn),
        executable: Some("/bin/claude-scripted".to_owned()),
        session_id: Some(Arc::new(|| "sess-1".to_owned())),
    });
    let callbacks = Arc::new(Host::default());
    let host = SessionHost {
        events: Arc::new(EventBuilder::new(Arc::new(|_| {}))),
        env: Default::default(),
        process_env: Default::default(),
        thread_storage_dir: String::new(),
        writable_roots: vec![],
        callbacks: callbacks.clone(),
    };
    let session = adapter.open(spec("/tmp"), options(provider_options), host).await.expect("open");
    let mut child = children.recv().await.expect("child");
    let initialize = child.next_written().await.expect("initialize");
    assert_eq!(initialize["request"]["subtype"], "initialize");
    (session, child, callbacks)
}

async fn hook(child: &mut Scripted, id: &str, tool: &str) -> Value {
    let input = json!({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {}});
    let request = json!({"type": "control_request", "request_id": id, "request": {
        "subtype": "hook_callback", "callback_id": "hook_0", "input": input, "tool_use_id": "t"}});
    child.write_line(&request.to_string()).await;
    child.next_written().await.expect("hook response")["response"]["response"].clone()
}

#[tokio::test]
async fn pre_tool_use_hook_denies_disabled_subagents_and_workflows() {
    let disabled = json!({"subagentsDisabled": true, "workflowsDisabled": true});
    let (_session, mut child, _) = open(disabled).await;
    let deny = |reason: &str| {
        json!({"continue": true, "hookSpecificOutput": {"hookEventName": "PreToolUse",
            "permissionDecision": "deny", "permissionDecisionReason": reason}})
    };
    assert_eq!(hook(&mut child, "a", "Agent").await, deny(SUBAGENTS_OFF));
    assert_eq!(hook(&mut child, "b", "Task").await, deny(SUBAGENTS_OFF));
    assert_eq!(hook(&mut child, "c", "Workflow").await, deny(WORKFLOWS_OFF));
    assert_eq!(hook(&mut child, "d", "Bash").await, json!({"continue": true}));
    let (_session, mut child, _) = open(json!({})).await;
    assert_eq!(hook(&mut child, "e", "Agent").await, json!({"continue": true}));
}

#[tokio::test]
async fn process_exit_reports_to_the_host_and_blocks_reuse() {
    let (session, child, host) = open(json!({})).await;
    assert!(session.can_apply(&spec("/tmp"), &options(json!({}))));
    assert!(!session.can_apply(&spec("/elsewhere"), &options(json!({}))));
    let unauthorized = json!({"type": "assistant", "session_id": "sess-1",
        "error": "authentication_failed", "message": {"role": "assistant", "content": []}});
    let mut child = child;
    child.write_line(&unauthorized.to_string()).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!session.can_apply(&spec("/tmp"), &options(json!({}))));
    child.finish(ChildExit { code: Some(1), signal: None, error: None });
    drop(child);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let exits = host.exits.lock().clone();
    assert_eq!(exits.len(), 1);
    assert_eq!(exits[0].message, "Claude Code process exited with code 1");
    let steer = SteerInput {
        client_request_id: "c".into(),
        input: vec![json!({"type": "text", "text": "hi"})],
        options: options(json!({})),
        expected_turn_id: "turn".into(),
    };
    assert_eq!(session.steer(steer).await.expect("steer"), SteerOutcome::Stale);
}
