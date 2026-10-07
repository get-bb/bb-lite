#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bb_claude::mcp::{McpServer, McpTool, McpToolResult};
use bb_claude::protocol::{
    CanUseToolRequest, ChildExit, ClaudeChild, ClaudeClient, ClaudeHandlers, ClientOptions,
    ExitInfo, InitializeParams, KillSignal, PermissionDecision,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines};
use tokio::sync::oneshot;

pub type ExitSender = Arc<Mutex<Option<oneshot::Sender<ChildExit>>>>;

pub struct Scripted {
    pub stdin: Lines<BufReader<DuplexStream>>,
    pub stdout: DuplexStream,
    pub stderr: DuplexStream,
    pub exit: ExitSender,
    pub signals: Arc<Mutex<Vec<KillSignal>>>,
}

impl Scripted {
    pub async fn write_line(&mut self, line: &str) {
        self.stdout.write_all(format!("{line}\n").as_bytes()).await.unwrap();
    }

    pub async fn next_written(&mut self) -> Option<Value> {
        let line = tokio::time::timeout(Duration::from_secs(5), self.stdin.next_line()).await;
        let line = line.expect("timed out waiting for a stdin line").unwrap()?;
        Some(serde_json::from_str(&line).unwrap())
    }

    pub fn finish(&self, exit: ChildExit) {
        if let Some(sender) = self.exit.lock().take() {
            let _ = sender.send(exit);
        }
    }
}

/// A child backed by in-memory pipes. SIGTERM/SIGKILL make it exit with that signal.
pub fn scripted_child() -> (ClaudeChild, Scripted) {
    let (stdin_client, stdin_test) = tokio::io::duplex(1 << 20);
    let (stdout_client, stdout_test) = tokio::io::duplex(1 << 20);
    let (stderr_client, stderr_test) = tokio::io::duplex(1 << 16);
    let (exit_tx, exit_rx) = oneshot::channel::<ChildExit>();
    let exit: ExitSender = Arc::new(Mutex::new(Some(exit_tx)));
    let signals = Arc::new(Mutex::new(Vec::new()));
    let child = ClaudeChild {
        stdin: Box::new(stdin_client),
        stdout: Box::new(stdout_client),
        stderr: Box::new(stderr_client),
        exit: Box::pin(async move { exit_rx.await.unwrap_or_default() }),
        signal: Box::new({
            let exit = exit.clone();
            let signals = signals.clone();
            move |signal| {
                signals.lock().push(signal);
                let name = if signal == KillSignal::Term { "SIGTERM" } else { "SIGKILL" };
                if let Some(sender) = exit.lock().take() {
                    let _ =
                        sender.send(ChildExit { signal: Some(name.into()), ..Default::default() });
                }
            }
        }),
    };
    let scripted = Scripted {
        stdin: BufReader::new(stdin_test).lines(),
        stdout: stdout_test,
        stderr: stderr_test,
        exit,
        signals,
    };
    (child, scripted)
}

#[derive(Default)]
pub struct Recorder {
    pub deny: bool,
    pub messages: Mutex<Vec<Value>>,
    pub exits: Mutex<Vec<ExitInfo>>,
    pub hooks: Mutex<Vec<(String, Value, Option<String>)>>,
    pub permissions: Mutex<Vec<CanUseToolRequest>>,
    pub hold_permissions: Option<Duration>,
}

#[async_trait]
impl ClaudeHandlers for Recorder {
    fn on_message(&self, message: Value) {
        self.messages.lock().push(message);
    }

    async fn can_use_tool(&self, request: CanUseToolRequest) -> PermissionDecision {
        self.permissions.lock().push(request.clone());
        if let Some(hold) = self.hold_permissions {
            tokio::time::sleep(hold).await;
        }
        if self.deny {
            PermissionDecision::deny("Permission request denied")
        } else {
            PermissionDecision::allow(request.input)
        }
    }

    async fn hook_callback(
        &self,
        callback_id: String,
        input: Value,
        tool_use_id: Option<String>,
    ) -> Result<Value, String> {
        self.hooks.lock().push((callback_id.clone(), input, tool_use_id));
        if callback_id == "hook_0" {
            Ok(json!({"continue": true}))
        } else {
            Err(format!("No hook callback found for ID: {callback_id}"))
        }
    }

    fn on_exit(&self, exit: ExitInfo) {
        self.exits.lock().push(exit);
    }
}

pub fn lookup_server() -> Arc<McpServer> {
    let tool = McpTool {
        name: "lookup".into(),
        description: "Look up a value".into(),
        input_schema: json!({"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}),
    };
    Arc::new(McpServer::new(
        "bb-bridge",
        vec![tool],
        Arc::new(|_name, arguments: Value, _tool_use_id| {
            Box::pin(async move {
                let key = arguments["key"].as_str().unwrap_or_default().to_owned();
                let value = if key == "a" { "42" } else { "?" };
                McpToolResult {
                    content: vec![json!({"type":"text","text": format!("value-of-{key}={value}")})],
                    is_error: false,
                }
            })
        }),
    ))
}

pub fn fixture(scenario: &str, file: &str) -> String {
    let path = format!("{}/tests/fixtures/raw/{scenario}/{file}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

pub struct Outcome {
    pub recorder: Arc<Recorder>,
    pub client: ClaudeClient,
    pub scripted: Scripted,
    pub control_results: Vec<(String, Value)>,
    pub written: Vec<Value>,
}

fn initialize_params(request: &Value) -> InitializeParams {
    let mut extra = request.as_object().cloned().unwrap_or_default();
    for key in ["subtype", "hooks", "sdkMcpServers", "appendSystemPrompt"] {
        extra.remove(key);
    }
    InitializeParams {
        hooks: request.get("hooks").cloned(),
        sdk_mcp_servers: request
            .get("sdkMcpServers")
            .map(|value| serde_json::from_value(value.clone()).unwrap()),
        append_system_prompt: request["appendSystemPrompt"].as_str().map(str::to_owned),
        extra,
        ..Default::default()
    }
}

/// Plays `stdout.ndjson` through a client in `interleaved.ndjson` order, asserting every line
/// the client writes equals the recorded stdin line with request ids mapped.
pub async fn replay(scenario: &str, deny: bool) -> Outcome {
    let recorder = Arc::new(Recorder { deny, ..Default::default() });
    let (child, mut scripted) = scripted_child();
    let options = ClientOptions { mcp_servers: vec![lookup_server()], ..Default::default() };
    let client = ClaudeClient::with_options(child, recorder.clone(), options);
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut controls = Vec::new();
    let mut written = Vec::new();
    let mut expected_messages = 0usize;
    for (index, entry) in fixture(scenario, "interleaved.ndjson").lines().enumerate() {
        let entry: Value = serde_json::from_str(entry).unwrap();
        let mut line = entry["line"].clone();
        if entry["dir"] == "out" {
            if line["type"] == "control_response" {
                let recorded = line["response"]["request_id"].as_str().unwrap_or_default();
                if let Some(ours) = ids.get(recorded) {
                    line["response"]["request_id"] = json!(ours);
                }
            } else if line["type"] != "control_request" {
                expected_messages += 1;
            }
            scripted.write_line(&line.to_string()).await;
            continue;
        }
        match line["type"].as_str() {
            Some("user") => client
                .send_user_message(
                    line["message"]["content"].clone(),
                    line["session_id"].as_str().unwrap(),
                    line["uuid"].as_str().unwrap(),
                )
                .unwrap(),
            Some("control_request") => {
                let request = &line["request"];
                let subtype = request["subtype"].as_str().unwrap().to_owned();
                let pending = if subtype == "initialize" {
                    client.initialize(initialize_params(request))
                } else {
                    let mut fields: Map<String, Value> = request.as_object().unwrap().clone();
                    fields.remove("subtype");
                    client.control_request(&subtype, fields)
                };
                controls.push((subtype, tokio::spawn(pending)));
            }
            _ => {}
        }
        let mut actual = scripted.next_written().await.expect("stdin closed early");
        written.push(actual.clone());
        if line["type"] == "control_request" {
            let ours = actual.as_object_mut().unwrap().remove("request_id").unwrap();
            let recorded = line.as_object_mut().unwrap().remove("request_id").unwrap();
            ids.insert(recorded.as_str().unwrap().into(), ours.as_str().unwrap().into());
        }
        assert_eq!(actual, line, "{scenario}: interleaved line {} differs", index + 1);
    }
    let mut control_results = Vec::new();
    for (subtype, handle) in controls {
        let result = tokio::time::timeout(Duration::from_secs(5), handle).await.unwrap().unwrap();
        control_results
            .push((subtype.clone(), result.unwrap_or_else(|e| panic!("{subtype}: {e}"))));
    }
    for _ in 0..500 {
        if recorder.messages.lock().len() >= expected_messages {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(recorder.messages.lock().len(), expected_messages, "{scenario}: message count");
    Outcome { recorder, client, scripted, control_results, written }
}
