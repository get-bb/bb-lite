#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use bb_codex::events::{CodexTranslator, CodexTranslatorHooks, InjectedTools};
use bb_codex::rpc::{AppServerChild, ChildExit};
use bb_provider::{EventBuilder, EventBuilderOptions, EventSink, Presentation};
use futures::FutureExt;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, WriteHalf};
use tokio::sync::watch;

pub const SCENARIOS: [&str; 11] = [
    "turn-tools",
    "steer",
    "stop-interrupt",
    "approval-allow",
    "approval-deny",
    "subagent",
    "resume",
    "web-search",
    "plan-mode",
    "user-question",
    "auth-failure",
];

const DROPPED: [&str; 3] =
    ["turn/diff/updated", "provider/rateLimits/updated", "provider/unhandled"];

pub fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/runner/test/fixtures/codex")
}

pub struct WireEntry {
    pub from: String,
    pub message: Value,
}

pub fn read_wire(scenario: &str) -> Vec<WireEntry> {
    let path = fixtures().join(format!("{scenario}.wire.ndjson"));
    let text = std::fs::read_to_string(path).expect("wire fixture");
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut entry: Value = serde_json::from_str(line).expect("wire line");
            let from = entry["from"].as_str().expect("from").to_owned();
            WireEntry { from, message: entry["message"].take() }
        })
        .collect()
}

pub fn read_original_events(scenario: &str) -> Vec<Value> {
    let path = fixtures().join(format!("{scenario}.events.json"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("events fixture")).expect("events")
}

/// The TypeScript `kept`: drops event types the replay never reproduces.
pub fn kept(events: Vec<Value>) -> Vec<Value> {
    let dropped = |event: &Value| DROPPED.contains(&event["type"].as_str().unwrap_or(""));
    events.into_iter().filter(|event| !dropped(event)).collect()
}

/// The TypeScript `internIds`: renumbers minted bb ids (and optionally provider thread ids) in
/// order of first appearance.
pub fn intern_ids(events: &[Value], session_ids: bool) -> Vec<Value> {
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut intern = |id: &str| {
        let next = format!("#{}", ids.len() + 1);
        ids.entry(id.to_owned()).or_insert(next).clone()
    };
    let text = serde_json::to_string(events).expect("serialize");
    let minted = Regex::new(r"da[0-9a-f]{8}-[ti]\d+").expect("regex");
    let mut text = minted.replace_all(&text, |c: &regex::Captures| intern(&c[0])).into_owned();
    if session_ids {
        let session = Regex::new(r#"("providerThreadId":")([^"]+)"#).expect("regex");
        text = session
            .replace_all(&text, |c: &regex::Captures| format!("{}{}", &c[1], intern(&c[2])))
            .into_owned();
    }
    serde_json::from_str(&text).expect("reparse")
}

pub fn collector() -> (EventSink, Arc<Mutex<Vec<Value>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    (Arc::new(move |event| sink.lock().push(event)), events)
}

pub fn builder(sink: EventSink) -> Arc<EventBuilder> {
    let mut options = EventBuilderOptions::new(sink);
    options.text_flush_ms = 0;
    options.now = Arc::new(|| 0);
    Arc::new(EventBuilder::with_options(options))
}

#[derive(Default)]
pub struct RecordingHooks {
    pub root: Mutex<Option<String>>,
    pub terminal_errors: Mutex<Vec<(String, String)>>,
}

impl CodexTranslatorHooks for RecordingHooks {
    fn root_thread_id(&self) -> Option<String> {
        self.root.lock().clone()
    }

    fn on_terminal_error(&self, category: &str, detail: &str) {
        self.terminal_errors.lock().push((category.to_owned(), detail.to_owned()));
    }
}

pub fn injected_tools(params: &Value) -> InjectedTools {
    let tools = params["dynamicTools"].as_array().cloned().unwrap_or_default();
    tools
        .iter()
        .filter_map(|tool| {
            let name = tool["name"].as_str()?.to_owned();
            let label = serde_json::from_value::<Presentation>(tool["presentation"].clone()).ok();
            Some((name, label))
        })
        .collect()
}

struct Session {
    events: Arc<EventBuilder>,
    translator: CodexTranslator,
    hooks: Arc<RecordingHooks>,
    resumed: bool,
}

/// Replays a recorded wire file through `CodexTranslator`. Besides the notifications it plays the
/// part of `codex.ts` that turns responses into builder calls: identity after `thread/start`,
/// `acceptInput` for `turn/start` and `turn/steer`, `openTurn`/`closeTurn` from the `turn/start`
/// result and `closeAgents` when the session closes. Server requests (approvals, tool calls) are
/// not answered.
pub fn replay_translator(scenario: &str) -> Vec<Value> {
    replay_translator_with(scenario, true)
}

/// `replay_translator`, optionally without the `codex.ts` plumbing (notifications only).
pub fn replay_translator_with(scenario: &str, plumbing: bool) -> Vec<Value> {
    let (sink, events) = collector();
    let mut session: Option<Session> = None;
    let mut requests: HashMap<String, String> = HashMap::new();
    let mut pending_turns: Vec<String> = Vec::new();
    let mut pending_steers: Vec<(String, String)> = Vec::new();
    for WireEntry { from, message } in read_wire(scenario) {
        let method = message["method"].as_str().map(str::to_owned);
        let params = &message["params"];
        let id = match &message["id"] {
            Value::Null => None,
            other => Some(other.to_string()),
        };
        match (from.as_str(), method.as_deref()) {
            ("runtime", Some("thread/start" | "thread/resume")) => {
                if let Some(mut old) = session.take() {
                    old.translator.close_agents(None);
                }
                let events = builder(Arc::clone(&sink));
                let resume = params["providerThreadId"].as_str();
                if let Some(resume) = resume {
                    events.identity(resume);
                }
                let hooks = Arc::new(RecordingHooks::default());
                let dyn_hooks: Arc<dyn CodexTranslatorHooks> = hooks.clone();
                let tools = injected_tools(params);
                let resumed = resume.is_some();
                let translator =
                    CodexTranslator::new(Arc::clone(&events), tools, dyn_hooks, resumed);
                session = Some(Session { events, translator, hooks, resumed });
                pending_turns.clear();
                pending_steers.clear();
            }
            ("runtime" | "client", _) | ("server", None) if !plumbing => {}
            ("runtime", Some(runtime)) => {
                let Some(s) = session.as_mut() else { continue };
                let request = params["clientRequestId"].as_str().unwrap_or("").to_owned();
                match runtime {
                    "thread/stop" if params["intent"] != "interrupt" => {
                        s.translator.close_agents(None);
                    }
                    "turn/start" => {
                        s.events.accept_input(&request, None);
                        pending_turns.push(request);
                    }
                    "turn/steer" => {
                        let expected = params["expectedTurnId"].as_str().unwrap_or("").to_owned();
                        pending_steers.push((request, expected));
                    }
                    _ => {}
                }
            }
            ("client", Some(client)) => {
                if let Some(id) = id {
                    requests.insert(id, client.to_owned());
                }
            }
            ("server", Some(notification)) => {
                if id.is_some() {
                    continue;
                }
                if let Some(s) = session.as_mut() {
                    s.translator.handle(notification, params);
                }
            }
            ("server", None) => {
                let Some(s) = session.as_mut() else { continue };
                let request = id.and_then(|id| requests.get(&id).cloned());
                let result = &message["result"];
                match request.as_deref() {
                    Some("thread/start" | "thread/resume") => {
                        let Some(thread) = result["thread"]["id"].as_str() else { continue };
                        *s.hooks.root.lock() = Some(thread.to_owned());
                        if !s.resumed {
                            s.events.identity(thread);
                        }
                    }
                    Some("turn/start") => {
                        let request = pending_turns.pop().unwrap_or_default();
                        let root = s.hooks.root.lock().clone().unwrap_or_default();
                        match CodexTranslator::parse_turn(&result["turn"]) {
                            Some((turn, status, _)) => {
                                s.translator.open_turn(&root, &turn);
                                if status != "inProgress" {
                                    s.translator.close_turn(&root, &result["turn"]);
                                }
                            }
                            None => s.events.retract_input(&request),
                        }
                    }
                    Some("turn/steer") => {
                        let (request, expected) = pending_steers.pop().unwrap_or_default();
                        if message.get("error").is_some() {
                            continue;
                        }
                        s.events.accept_input(&request, Some(&expected));
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    if let Some(mut s) = session.take() {
        s.translator.close_agents(None);
    }
    events.lock().clone()
}

/// Index and both sides of the first difference, or `None` when the sequences are equal.
pub fn first_difference(actual: &[Value], expected: &[Value]) -> Option<String> {
    let length = actual.len().max(expected.len());
    (0..length).find(|i| actual.get(*i) != expected.get(*i)).map(|i| {
        let show = |v: Option<&Value>| v.map_or("<none>".to_owned(), Value::to_string);
        format!(
            "event {i} of {}/{}:\n  actual   {}\n  expected {}",
            actual.len(),
            expected.len(),
            show(actual.get(i)),
            show(expected.get(i))
        )
    })
}

pub type Stdout = Arc<tokio::sync::Mutex<Option<WriteHalf<DuplexStream>>>>;

pub struct FakeAppServer {
    pub written: Arc<Mutex<Vec<Value>>>,
    pub stdout: Stdout,
}

/// A scripted `codex app-server`: records what the adapter writes and serves `stdout`; it exits
/// when the adapter closes its stdin or signals it.
pub fn fake_app_server() -> (FakeAppServer, AppServerChild) {
    let (stdin_ours, stdin_theirs) = tokio::io::duplex(1 << 20);
    let (stdout_ours, stdout_theirs) = tokio::io::duplex(1 << 20);
    let (stdout_read, stdout_write) = tokio::io::split(stdout_ours);
    drop(stdout_read);
    let (_, stderr) = tokio::io::duplex(64);
    let written = Arc::new(Mutex::new(Vec::new()));
    let stdout: Stdout = Arc::new(tokio::sync::Mutex::new(Some(stdout_write)));
    let (finished, mut exited) = watch::channel(false);
    let finished = Arc::new(finished);
    let (sink, out, done) = (written.clone(), stdout.clone(), finished.clone());
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdin_theirs).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.is_empty() {
                sink.lock().push(serde_json::from_str(&line).expect("adapter wrote JSON"));
            }
        }
        out.lock().await.take();
        done.send_replace(true);
    });
    let exit = async move {
        let _ = exited.wait_for(|done| *done).await;
        ChildExit { code: Some(0), signal: None, error: None }
    };
    let child = AppServerChild {
        stdin: Box::new(stdin_ours),
        stdout: Box::new(stdout_theirs),
        stderr: Box::new(stderr),
        exit: exit.boxed(),
        signal: Box::new(move |_| {
            finished.send_replace(true);
        }),
    };
    (FakeAppServer { written, stdout }, child)
}
