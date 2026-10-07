mod replay;
#[allow(dead_code)]
mod translate_support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bb_claude::protocol::{ChildExit, ClaudeChild};
use bb_claude::session::{ClaudeAdapterOptions, SpawnClaude, create_claude_adapter};
use bb_core::env::EnvMap;
use bb_core::{ExecutionOptions, RunnerResult, SessionSpec, ToolCallResponse};
use bb_provider::{
    EventBuilder, EventSink, ExitInfo, Interaction, ProviderSession, SessionHost,
    SessionHostCallbacks, SteerInput, ToolCall, TurnInput,
};
use parking_lot::Mutex;
use replay::{Scripted, scripted_child};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use translate_support::{first_difference, intern_ids, kept, merge_deltas, read_lines, root};

const EXCLUDED: [&str; 1] = ["provider.env-resolved"];

struct Host {
    deny: bool,
    exits: Mutex<Vec<ExitInfo>>,
}

#[async_trait]
impl SessionHostCallbacks for Host {
    async fn call_tool(&self, _call: ToolCall) -> RunnerResult<ToolCallResponse> {
        let result = json!({"success": true, "contentItems": [{"type": "inputText", "text": "value-of-a=42"}]});
        Ok(serde_json::from_value(result).expect("tool response"))
    }

    async fn request_interaction(&self, _interaction: Interaction) -> RunnerResult<Value> {
        Ok(if self.deny {
            json!({"decision": "deny"})
        } else {
            json!({"decision": "allow_once", "grantedPermissions": null})
        })
    }

    fn on_exit(&self, info: ExitInfo) {
        self.exits.lock().push(info);
    }
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

fn strip_ids(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, _)| !matches!(k.as_str(), "request_id" | "uuid" | "session_id"))
                .map(|(k, v)| (k.clone(), strip_ids(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(strip_ids).collect()),
        other => other.clone(),
    }
}

fn recorded_events(dir: &Path) -> Vec<Value> {
    let raw = std::fs::read_to_string(dir.join("events.json")).expect("events.json");
    let runner: Vec<Value> = serde_json::from_str(&raw).expect("events");
    runner
        .iter()
        .filter(|e| str_at(e, "/kind") == Some("thread.events"))
        .filter_map(|e| e.get("events").and_then(Value::as_array))
        .flatten()
        .cloned()
        .collect()
}

fn options() -> ExecutionOptions {
    serde_json::from_value(json!({
        "model": "claude-haiku-4-5", "reasoningLevel": "low", "serviceTier": "default",
        "permissionMode": "accept-edits", "permissionEscalation": "ask", "providerOptions": {}
    }))
    .expect("options")
}

fn spec(meta: &Value, lines: &[Value], resume: Option<&str>, tools: bool) -> SessionSpec {
    let instructions = lines
        .iter()
        .find_map(|e| str_at(e, "/line/request/appendSystemPrompt"))
        .unwrap_or_default();
    let lookup = json!({"name": "lookup", "description": "Look up a value", "inputSchema": {
        "type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}});
    serde_json::from_value(json!({
        "threadId": str_at(meta, "/threadId"), "providerId": "claude-code",
        "cwd": str_at(meta, "/cwd"), "providerThreadId": resume, "instructions": instructions,
        "dynamicTools": if tools { vec![lookup] } else { vec![] }, "env": {}, "skillDirs": []
    }))
    .expect("spec")
}

struct Drive {
    stdin_mismatches: Vec<String>,
    events: Arc<Mutex<Vec<Value>>>,
    exits: Vec<ExitInfo>,
}

async fn next_written(child: &mut Scripted) -> Option<Value> {
    tokio::time::timeout(Duration::from_secs(5), child.next_written()).await.ok().flatten()
}

async fn replay_scenario(scenario: &str) -> Drive {
    let dir = root().join("tests/fixtures/raw").join(scenario);
    let meta: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).expect("meta"))
            .expect("meta json");
    let recorded = recorded_events(&dir);
    let mut client_ids = recorded
        .iter()
        .filter(|e| str_at(e, "/type") == Some("turn/input/accepted"))
        .filter_map(|e| str_at(e, "/clientRequestId").map(str::to_owned))
        .collect::<Vec<_>>()
        .into_iter();
    let (sender, mut children) = mpsc::unbounded_channel::<Scripted>();
    let spawn: SpawnClaude = Arc::new(move |_: &str, _: &[String], _: &str, _: &EnvMap| {
        let (child, scripted): (ClaudeChild, Scripted) = scripted_child();
        let _ = sender.send(scripted);
        child
    });
    let next_id = Arc::new(Mutex::new(String::new()));
    let current = next_id.clone();
    let adapter = create_claude_adapter(ClaudeAdapterOptions {
        spawn: Some(spawn),
        executable: Some("/bin/claude-scripted".to_owned()),
        session_id: Some(Arc::new(move || current.lock().clone())),
    });
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let emit: EventSink = Arc::new(move |event| sink.lock().push(event));
    let callbacks = Arc::new(Host { deny: scenario == "approval-deny", exits: Mutex::new(vec![]) });
    let mut stdin_mismatches = Vec::new();
    let spawns: Vec<PathBuf> = std::iter::once(dir.clone())
        .chain((2..).map(|n| dir.join(format!("spawn-{n}"))).take_while(|spawn| spawn.is_dir()))
        .collect();
    let resume = (scenario == "resume")
        .then(|| {
            let simple = root().join("tests/fixtures/raw/simple/meta.json");
            let meta: Value = serde_json::from_str(&std::fs::read_to_string(simple).ok()?).ok()?;
            str_at(&meta, "/providerThreadId").map(str::to_owned)
        })
        .flatten();
    for (index, spawn) in spawns.iter().enumerate() {
        let lines = read_lines(&spawn.join("interleaved.ndjson"));
        let exit: Value = serde_json::from_str(
            &std::fs::read_to_string(spawn.join("exit.json")).unwrap_or_else(|_| "{}".into()),
        )
        .unwrap_or_default();
        let host = SessionHost {
            events: Arc::new(EventBuilder::new(emit.clone())),
            env: Default::default(),
            process_env: Default::default(),
            thread_storage_dir: String::new(),
            writable_roots: vec![],
            callbacks: callbacks.clone(),
        };
        let builder = host.events.clone();
        let written_id = lines
            .iter()
            .filter(|e| str_at(e, "/dir") == Some("in"))
            .find_map(|e| str_at(e, "/line/session_id"));
        *next_id.lock() = written_id.unwrap_or("session").to_owned();
        let spec = spec(&meta, &lines, resume.as_deref(), scenario == "dynamic-tool");
        let session: Arc<dyn ProviderSession> =
            adapter.open(spec, options(), host).await.expect("open");
        let mut child = children.recv().await.expect("child");
        let mut ids: Vec<(String, String)> = Vec::new();
        let interrupts_turn = scenario == "interrupt" && index == 0;
        let mut closing = None;
        for entry in &lines {
            let Some(line) = entry.get("line") else { continue };
            if str_at(entry, "/dir") == Some("in") {
                let subtype = str_at(line, "/request/subtype");
                if str_at(line, "/type") == Some("user") {
                    let client_request_id = client_ids.next().unwrap_or_default();
                    let input = vec![json!({"type": "text", "text":
                        line.pointer("/message/content").and_then(Value::as_str).unwrap_or_default()})];
                    let session = session.clone();
                    match builder.active_turn_id() {
                        Some(expected_turn_id) => {
                            let steer = SteerInput {
                                client_request_id,
                                input,
                                options: options(),
                                expected_turn_id,
                            };
                            tokio::spawn(async move { session.steer(steer).await });
                        }
                        None => {
                            let turn = TurnInput { client_request_id, input, options: options() };
                            tokio::spawn(async move { session.start_turn(turn).await });
                        }
                    }
                } else if subtype == Some("interrupt") && closing.is_none() {
                    let session = session.clone();
                    if interrupts_turn {
                        tokio::spawn(async move { session.interrupt().await });
                    } else {
                        closing = Some(tokio::spawn(async move { session.close().await }));
                    }
                }
                let Some(ours) = next_written(&mut child).await else {
                    stdin_mismatches.push(format!("{scenario}#{index}: missing {line}"));
                    break;
                };
                if let (Some(theirs), Some(mine)) =
                    (str_at(line, "/request_id"), str_at(&ours, "/request_id"))
                {
                    ids.push((theirs.to_owned(), mine.to_owned()));
                }
                if strip_ids(&ours) != strip_ids(line) && stdin_mismatches.len() < 3 {
                    stdin_mismatches.push(format!(
                        "{scenario}#{index}:\n  ours:     {ours}\n  recorded: {line}"
                    ));
                }
            } else {
                let mut line = line.clone();
                if let Some(Value::String(id)) = line.pointer_mut("/response/request_id")
                    && let Some((_, mine)) = ids.iter().find(|(theirs, _)| theirs == id)
                {
                    *id = mine.clone();
                }
                child.write_line(&line.to_string()).await;
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        let code = exit.get("code").and_then(Value::as_i64).map(|c| c as i32);
        let signal = str_at(&exit, "/signal").map(str::to_owned);
        child.finish(ChildExit { code, signal, error: None });
        drop(child);
        if closing.is_none() {
            let session = session.clone();
            closing = Some(tokio::spawn(async move { session.close().await }));
        }
        if let Some(closing) = closing {
            let _ = tokio::time::timeout(Duration::from_secs(10), closing).await;
        }
    }
    let exits = callbacks.exits.lock().clone();
    Drive { stdin_mismatches, events, exits }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn raw_recordings_replay_through_the_session() {
    let scenarios = [
        "simple",
        "approval-allow",
        "approval-deny",
        "dynamic-tool",
        "tool-auto-approved",
        "interrupt",
        "resume",
        "steer",
    ];
    let mut failures = Vec::new();
    for scenario in scenarios {
        let drive = replay_scenario(scenario).await;
        let dir = root().join("tests/fixtures/raw").join(scenario);
        let ours = intern_ids(&merge_deltas(kept(drive.events.lock().clone(), &EXCLUDED)));
        let recorded = intern_ids(&merge_deltas(kept(recorded_events(&dir), &EXCLUDED)));
        let events = first_difference(&ours, &recorded);
        println!(
            "{scenario}: stdin {} / events {} / exits {:?}",
            if drive.stdin_mismatches.is_empty() { "match" } else { "MISMATCH" },
            events.as_deref().unwrap_or("match"),
            drive.exits.iter().map(|e| e.message.clone()).collect::<Vec<_>>()
        );
        failures.extend(drive.stdin_mismatches);
        failures.extend(events.map(|diff| format!("{scenario}: {diff}")));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
