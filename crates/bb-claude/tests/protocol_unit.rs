mod replay;

use std::sync::Arc;
use std::time::Duration;

use bb_claude::mcp::{McpServer, McpTool, McpToolResult};
use bb_claude::protocol::{
    ChildExit, ClaudeClient, ClaudeError, ClientOptions, ExitInfo, KillSignal, PermissionDecision,
};
use replay::{Recorder, Scripted, lookup_server, scripted_child};
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;

fn client_with(recorder: Recorder, timeout: Duration) -> (ClaudeClient, Scripted, Arc<Recorder>) {
    let recorder = Arc::new(recorder);
    let (child, scripted) = scripted_child();
    let options = ClientOptions { request_timeout: timeout, mcp_servers: vec![lookup_server()] };
    (ClaudeClient::with_options(child, recorder.clone(), options), scripted, recorder)
}

async fn wait_messages(recorder: &Recorder, count: usize) {
    for _ in 0..200 {
        if recorder.messages.lock().len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("expected {count} messages, got {:?}", recorder.messages.lock());
}

fn response_to(request: &Value, response: Value) -> String {
    json!({"type":"control_response","response":{"subtype":"success","request_id":request["request_id"],"response":response}}).to_string()
}

#[tokio::test]
async fn request_times_out_and_late_reply_is_ignored() {
    let (client, mut scripted, recorder) =
        client_with(Recorder::default(), Duration::from_millis(50));
    let result = client.set_model(Some("claude-sonnet-4-6")).await;
    assert_eq!(result, Err(ClaudeError::Timeout("set_model".into())));
    assert_eq!(result.unwrap_err().to_string(), "Control request timeout: set_model");
    let request = scripted.next_written().await.unwrap();
    assert_eq!(request["request"], json!({"subtype":"set_model","model":"claude-sonnet-4-6"}));
    scripted.write_line(&response_to(&request, json!({}))).await;
    scripted.write_line(r#"{"type":"system","subtype":"status"}"#).await;
    wait_messages(&recorder, 1).await;
    assert_eq!(recorder.messages.lock()[0]["type"], "system");
}

#[tokio::test]
async fn control_requests_serialize_like_the_sdk() {
    let (client, mut scripted, _) = client_with(Recorder::default(), Duration::from_secs(5));
    let _model = client.set_model(None);
    let _mode = client.set_permission_mode("plan");
    let _flags = client.apply_flag_settings(json!({"effortLevel":"high"}));
    let mut fields = Map::new();
    fields.insert("cancel_queued".into(), json!(true));
    let _interrupt = client.control_request("interrupt", fields);
    let mut requests = Vec::new();
    for _ in 0..4 {
        let line = scripted.next_written().await.unwrap();
        let id = line["request_id"].as_str().unwrap();
        assert_eq!(id.len(), 11);
        assert!(id.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()));
        assert_eq!(line["type"], "control_request");
        requests.push(line["request"].clone());
    }
    assert_eq!(
        requests,
        vec![
            json!({"subtype":"set_model"}),
            json!({"subtype":"set_permission_mode","mode":"plan"}),
            json!({"subtype":"apply_flag_settings","settings":{"effortLevel":"high"}}),
            json!({"subtype":"interrupt","cancel_queued":true}),
        ]
    );
}

#[tokio::test]
async fn error_reply_fails_the_request() {
    let (client, mut scripted, _) = client_with(Recorder::default(), Duration::from_secs(5));
    let pending = client.interrupt();
    let request = scripted.next_written().await.unwrap();
    let reply = json!({"type":"control_response","response":{"subtype":"error","request_id":request["request_id"],"error":"nope"}});
    scripted.write_line(&reply.to_string()).await;
    assert_eq!(pending.await, Err(ClaudeError::Response("nope".into())));
}

#[tokio::test]
async fn exit_fails_pending_requests_and_reports_stderr() {
    let (client, mut scripted, recorder) = client_with(Recorder::default(), Duration::from_secs(5));
    let pending = client.initialize(Default::default());
    assert_eq!(scripted.next_written().await.unwrap()["request"], json!({"subtype":"initialize"}));
    scripted.stderr.write_all(b"first\nboom\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    drop(std::mem::replace(&mut scripted.stdout, tokio::io::duplex(1).0));
    scripted.finish(ChildExit { code: Some(2), ..Default::default() });
    let message = "Claude Code process exited with code 2. stderr: first\nboom";
    assert_eq!(pending.await, Err(ClaudeError::Exited(message.into())));
    client.wait_exit().await;
    let exits = recorder.exits.lock().clone();
    assert_eq!(
        exits,
        vec![ExitInfo {
            code: Some(2),
            signal: None,
            error: None,
            stderr_tail: "first\nboom".into()
        }]
    );
    assert!(scripted.next_written().await.is_none());
    assert!(matches!(client.interrupt().await, Err(ClaudeError::Exited(_))));
    assert!(client.send_user_message(json!("hi"), "s", "u").is_err());
}

#[tokio::test]
async fn garbage_and_echoes_never_break_the_loop() {
    let (client, mut scripted, recorder) = client_with(Recorder::default(), Duration::from_secs(5));
    let pending = client.interrupt();
    let request = scripted.next_written().await.unwrap();
    for line in [
        "not json",
        "",
        "   ",
        "[1,2]",
        "42",
        r#"{"type":"control_response"}"#,
        r#"{"type":"control_response","response":{"subtype":"success","request_id":"echo-of-ours","response":{"continue":true}}}"#,
        r#"{"type":"control_request","request":{"subtype":"can_use_tool"}}"#,
        r#"{"type":"control_cancel_request","request_id":"unknown"}"#,
        r#"{"type":"keep_alive"}"#,
        r#"{"type":"brand_new","x":1}"#,
        r#"{"no_type":true}"#,
    ] {
        scripted.write_line(line).await;
    }
    scripted.write_line(&response_to(&request, json!({"still_queued":[]}))).await;
    assert_eq!(pending.await, Ok(json!({"still_queued":[]})));
    scripted.write_line(r#"{"type":"result","subtype":"success"}"#).await;
    wait_messages(&recorder, 3).await;
    let kinds: Vec<Value> = recorder.messages.lock().iter().map(|m| m["type"].clone()).collect();
    assert_eq!(&kinds[..2], &[json!("brand_new"), Value::Null]);
    assert_eq!(kinds.last(), Some(&json!("result")));
    assert!(!client.is_exited());
}

#[tokio::test]
async fn unknown_subtypes_and_callbacks_get_error_responses() {
    let (_client, mut scripted, _) = client_with(Recorder::default(), Duration::from_secs(5));
    scripted
        .write_line(
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"elicitation"}}"#,
        )
        .await;
    assert_eq!(
        scripted.next_written().await.unwrap().to_string(),
        r#"{"type":"control_response","response":{"subtype":"error","request_id":"r1","error":"Unsupported control request subtype: elicitation"}}"#
    );
    scripted.write_line(r#"{"type":"control_request","request_id":"r2","request":{"subtype":"hook_callback","callback_id":"hook_9","input":{}}}"#).await;
    assert_eq!(
        scripted.next_written().await.unwrap()["response"],
        json!({"subtype":"error","request_id":"r2","error":"No hook callback found for ID: hook_9"})
    );
    scripted.write_line(r#"{"type":"control_request","request_id":"r3","request":{"subtype":"mcp_message","server_name":"other","message":{"jsonrpc":"2.0","id":0,"method":"ping"}}}"#).await;
    assert_eq!(
        scripted.next_written().await.unwrap()["response"]["error"],
        "SDK MCP server not found: other"
    );
}

#[tokio::test]
async fn slow_permission_does_not_block_reads_and_can_be_cancelled() {
    let recorder =
        Recorder { hold_permissions: Some(Duration::from_millis(300)), ..Default::default() };
    let (_client, mut scripted, recorder) = client_with(recorder, Duration::from_secs(5));
    let ask = |id: &str| {
        json!({"type":"control_request","request_id":id,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"toolu_1"}}).to_string()
    };
    scripted.write_line(&ask("p1")).await;
    scripted.write_line(&ask("p2")).await;
    scripted.write_line(r#"{"type":"stream_event","event":{"type":"ping"}}"#).await;
    wait_messages(&recorder, 1).await;
    assert_eq!(recorder.permissions.lock().len(), 2);
    scripted.write_line(r#"{"type":"control_cancel_request","request_id":"p1"}"#).await;
    let reply = scripted.next_written().await.unwrap();
    assert_eq!(
        reply["response"],
        json!({"subtype":"success","request_id":"p2","response":{"behavior":"allow","updatedInput":{"command":"ls"},"decisionClassification":"user_temporary","toolUseID":"toolu_1"}})
    );
    let next = tokio::time::timeout(Duration::from_millis(400), scripted.stdin.next_line()).await;
    assert!(next.is_err(), "cancelled request was answered: {next:?}");
}

#[tokio::test]
async fn close_interrupts_ends_stdin_and_skips_on_exit() {
    let (client, mut scripted, recorder) = client_with(Recorder::default(), Duration::from_secs(5));
    let closing = tokio::spawn({
        let client = client.clone();
        async move { client.close().await }
    });
    let request = scripted.next_written().await.unwrap();
    assert_eq!(request["request"]["subtype"], "interrupt");
    scripted.write_line(&response_to(&request, json!({"still_queued":[]}))).await;
    assert!(scripted.next_written().await.is_none());
    scripted.finish(ChildExit { code: Some(0), ..Default::default() });
    closing.await.unwrap();
    assert!(recorder.exits.lock().is_empty());
    assert!(scripted.signals.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn close_escalates_to_sigterm_then_sigkill() {
    let (client, mut scripted, _) = client_with(Recorder::default(), Duration::from_secs(60));
    let _never_exits = scripted.exit.lock().take();
    let closing = tokio::spawn({
        let client = client.clone();
        async move { client.close().await }
    });
    assert_eq!(scripted.next_written().await.unwrap()["request"]["subtype"], "interrupt");
    tokio::time::sleep(Duration::from_millis(6_500)).await;
    assert!(scripted.signals.lock().is_empty());
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    assert_eq!(*scripted.signals.lock(), vec![KillSignal::Term]);
    tokio::time::sleep(Duration::from_millis(5_000)).await;
    assert_eq!(*scripted.signals.lock(), vec![KillSignal::Term, KillSignal::Kill]);
    assert!(scripted.next_written().await.is_none());
    assert!(!closing.is_finished());
    drop(closing);
}

#[test]
fn permission_decisions_serialize() {
    let deny = PermissionDecision::Deny {
        message: "no".into(),
        interrupt: true,
        decision_classification: "user_reject".into(),
    };
    assert_eq!(
        deny.to_response(None).to_string(),
        r#"{"behavior":"deny","message":"no","interrupt":true,"decisionClassification":"user_reject"}"#
    );
    let allow = PermissionDecision::Allow {
        updated_input: json!({}),
        updated_permissions: Some(vec![
            json!({"type":"setMode","mode":"plan","destination":"session"}),
        ]),
        decision_classification: "user_permanent".into(),
    };
    assert_eq!(
        allow.to_response(Some("t")).to_string(),
        r#"{"behavior":"allow","updatedInput":{},"updatedPermissions":[{"type":"setMode","mode":"plan","destination":"session"}],"decisionClassification":"user_permanent","toolUseID":"t"}"#
    );
}

#[tokio::test]
async fn mcp_server_edge_cases() {
    let server = McpServer::new(
        "s",
        vec![McpTool { name: "fail".into(), description: "d".into(), input_schema: json!({}) }],
        Arc::new(|name, arguments, tool_use_id| {
            Box::pin(async move {
                McpToolResult {
                    content: vec![json!({"name": name, "args": arguments, "id": tool_use_id})],
                    is_error: true,
                }
            })
        }),
    );
    assert_eq!(
        server.handle(json!({"jsonrpc":"2.0","id":5,"method":"ping"})).await,
        json!({"result":{},"jsonrpc":"2.0","id":5})
    );
    assert_eq!(
        server.handle(json!({"jsonrpc":"2.0","method":"notifications/cancelled"})).await,
        json!({"jsonrpc":"2.0","result":{},"id":0})
    );
    assert_eq!(
        server.handle(json!({"jsonrpc":"2.0","id":"x","method":"resources/list"})).await,
        json!({"jsonrpc":"2.0","id":"x","error":{"code":-32601,"message":"Method not found"}})
    );
    let call = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fail","arguments":{"a":1},"_meta":{"claudecode/toolUseId":"toolu_9"}}});
    assert_eq!(
        server.handle(call).await.to_string(),
        r#"{"result":{"content":[{"name":"fail","args":{"a":1},"id":"toolu_9"}],"isError":true},"jsonrpc":"2.0","id":3}"#
    );
    let missing = json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nope"}});
    assert_eq!(
        server.handle(missing).await["result"],
        json!({"content":[{"type":"text","text":"MCP error -32602: Tool nope not found"}],"isError":true})
    );
}

#[tokio::test]
async fn spawn_claude_runs_a_real_process_with_exact_env() {
    let dir = tempfile::tempdir().unwrap();
    let mut env = bb_core::env::EnvMap::new();
    env.insert("ONLY".into(), "yes".into());
    let script = r#"read line; printf '{"type":"system","env":"%s","home":"%s","line":%s}\n' "$ONLY" "$HOME" "$line"; echo oops >&2; exit 3"#;
    let args = vec!["-c".to_owned(), script.to_owned()];
    let child =
        bb_claude::protocol::spawn_claude("/bin/sh", &args, dir.path().to_str().unwrap(), &env);
    let recorder = Arc::new(Recorder::default());
    let client = ClaudeClient::new(child, recorder.clone());
    client.send_user_message(json!("hi"), "s", "u").unwrap();
    tokio::time::timeout(Duration::from_secs(10), client.wait_exit()).await.unwrap();
    let messages = recorder.messages.lock().clone();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["env"], "yes");
    assert_eq!(messages[0]["home"], "");
    assert_eq!(messages[0]["line"]["uuid"], "u");
    let exits = recorder.exits.lock().clone();
    assert_eq!(exits[0].code, Some(3));
    assert_eq!(exits[0].stderr_tail, "oops");
    assert_eq!(exits[0].message(), "Claude Code process exited with code 3. stderr: oops");

    let missing = bb_claude::protocol::spawn_claude("/nonexistent/claude", &[], "/", &env);
    let recorder = Arc::new(Recorder::default());
    let client = ClaudeClient::new(missing, recorder.clone());
    tokio::time::timeout(Duration::from_secs(5), client.wait_exit()).await.unwrap();
    assert_eq!(recorder.exits.lock()[0].error.as_deref(), Some("spawn /nonexistent/claude ENOENT"));
}
