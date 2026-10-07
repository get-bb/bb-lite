use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use bb_claude::tools::ToolContext;
use bb_claude::translate::ClaudeTranslator;
use bb_provider::{EventBuilder, EventSink};
use parking_lot::Mutex;
use regex::{Captures, Regex};
use serde_json::{Value, json};

pub const DROPPED: [&str; 3] =
    ["turn/diff/updated", "provider/rateLimits/updated", "provider/unhandled"];

pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub fn read_lines(path: &PathBuf) -> Vec<Value> {
    let raw = std::fs::read_to_string(path).expect("fixture");
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Plays the part of `claude.ts` around the translator: one builder and translator per session.
pub struct Harness {
    pub events: Arc<Mutex<Vec<Value>>>,
    live: Option<(Arc<EventBuilder>, ClaudeTranslator, String)>,
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

impl Harness {
    pub fn new() -> Self {
        Self { events: Arc::new(Mutex::new(Vec::new())), live: None }
    }

    pub fn open(&mut self, session_id: &str, model: Option<&str>, sandboxed: bool) {
        self.close();
        let sink = self.events.clone();
        let emit: EventSink = Arc::new(move |event| sink.lock().push(event));
        let builder = Arc::new(EventBuilder::new(emit));
        let mut translator = ClaudeTranslator::new(
            builder.clone(),
            ToolContext { sandboxed, ..ToolContext::default() },
        );
        if let Some(model) = model.filter(|m| !m.is_empty()) {
            translator.set_model(model);
        }
        builder.identity(session_id);
        let unknown = json!({ "usedTokens": null, "modelContextWindow": null, "estimated": true });
        builder.context_window(unknown, None, false);
        self.live = Some((builder, translator, session_id.to_owned()));
    }

    pub fn submit(&mut self, client_request_id: Option<&str>) {
        let Some((builder, translator, _)) = self.live.as_mut() else { return };
        translator.accept_input();
        if let Some(id) = client_request_id {
            builder.accept_input(id, None);
        }
        if builder.active_turn_id().is_none() {
            builder.open_turn(None, None);
        }
    }

    pub fn receive(&mut self, message: &Value) {
        let Some((builder, translator, current)) = self.live.as_mut() else { return };
        let session = message.get("session_id").and_then(Value::as_str).map(str::trim);
        if let Some(session) = session.filter(|s| !s.is_empty() && *s != current) {
            *current = session.to_owned();
            builder.identity(session);
        }
        translator.handle(message);
    }

    pub fn stop(&mut self, interrupt: bool) {
        if let Some((builder, translator, _)) = self.live.as_mut() {
            if interrupt {
                builder.settle("interrupted", None);
            }
            translator.stop_tasks();
            builder.settle("interrupted", None);
        }
        self.live = None;
    }

    pub fn close(&mut self) {
        if let Some((builder, translator, _)) = self.live.as_mut() {
            translator.stop_tasks();
            builder.flush();
        }
        self.live = None;
    }
}

/// `internIds` from kit.ts with one regex, so ids are numbered by first appearance.
pub fn intern_ids(events: &[Value]) -> Vec<Value> {
    let mut ids: HashMap<String, String> = HashMap::new();
    let text = serde_json::to_string(events).expect("json");
    let pattern =
        Regex::new(r#"da[0-9a-f]{8}-[ti]\d+|("providerThreadId":")([^"]+)"#).expect("regex");
    let text = pattern.replace_all(&text, |c: &Captures| {
        let (prefix, id) = match (c.get(1), c.get(2)) {
            (Some(prefix), Some(id)) => (prefix.as_str(), id.as_str()),
            _ => ("", &c[0]),
        };
        let next = format!("#{}", ids.len() + 1);
        format!("{prefix}{}", ids.entry(id.to_owned()).or_insert(next))
    });
    serde_json::from_str(&text).expect("json")
}

/// Joins consecutive text deltas of one item: their chunking depends on wall-clock flush timing.
pub fn merge_deltas(events: Vec<Value>) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    for event in events {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let text_delta =
            kind.starts_with("item/") && kind.contains("elta") && event.get("delta").is_some();
        if let Some(last) = merged.last_mut().filter(|last| {
            text_delta
                && last.get("type") == event.get("type")
                && last.get("itemId") == event.get("itemId")
        }) {
            let joined = format!(
                "{}{}",
                last["delta"].as_str().unwrap_or(""),
                event["delta"].as_str().unwrap_or("")
            );
            last["delta"] = Value::from(joined);
            continue;
        }
        merged.push(event);
    }
    merged
}

pub fn kept(events: Vec<Value>, excluded: &[&str]) -> Vec<Value> {
    events
        .into_iter()
        .filter(|e| {
            let kind = e.get("type").and_then(Value::as_str).unwrap_or("");
            !DROPPED.contains(&kind) && !excluded.contains(&kind)
        })
        .collect::<Vec<_>>()
}

pub fn first_difference(actual: &[Value], recorded: &[Value]) -> Option<String> {
    let shown = |v: Option<&Value>| {
        let text = v.map_or("<none>".to_owned(), Value::to_string);
        text.chars().take(400).collect::<String>()
    };
    let index =
        (0..actual.len().max(recorded.len())).find(|&i| actual.get(i) != recorded.get(i))?;
    Some(format!(
        "event {index} of {}/{}:\n  ours:     {}\n  recorded: {}",
        actual.len(),
        recorded.len(),
        shown(actual.get(index)),
        shown(recorded.get(index))
    ))
}
