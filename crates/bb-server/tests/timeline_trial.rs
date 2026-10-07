//! Compares the Rust timeline with responses recorded from a real TypeScript instance.
//!
//! A no-op unless `BB_TRIAL_DIR` points at a directory of `<thread id>.json` files in the
//! parity fixture format (plus `display`, `environmentPath`, `turnSummaryDetailsList` and,
//! for recordings made with a non-default window, `eventBudget`). Events are the decoded
//! `{event, meta}` entries; a `GET /threads/:id/events` row maps back as
//! `event = {...data, type, threadId, scope}`, `meta = {id, seq, createdAt}`.
//! The data is private and never lives in the repository. `BB_TRIAL_REPORT=<file>` writes
//! every difference as a JSON line holding the path and a shortened value only.

#[path = "timeline_window_support.rs"]
mod support;

use std::io::Write;

use bb_server::threads::timeline::{TimelineDisplay, TimelineReader, TurnDetailsRequest};
use bb_thread_view::group_turns::CompletedTurnDisplay;
use serde_json::{Value, json};
use support::*;

const MAX_DIFFERENCES_PER_QUERY: usize = 25;

/// `(path, actual, expected)` with shortened values.
type Difference = (String, Value, Value);

/// Strings longer than a short label are reported by length only, so no content leaks.
fn short(value: &Value) -> Value {
    match value {
        Value::String(text) if text.chars().count() > 32 => json!(format!("<str {}>", text.len())),
        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null => value.clone(),
        Value::Array(items) => json!(format!("<array {}>", items.len())),
        Value::Object(map) => json!(format!("<object {}>", map.len())),
    }
}

fn differences(path: &str, left: &Value, right: &Value, out: &mut Vec<Difference>) {
    if out.len() >= MAX_DIFFERENCES_PER_QUERY {
        return;
    }
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let child = format!("{path}.{key}");
                match (a.get(key), b.get(key)) {
                    (Some(l), Some(r)) => differences(&child, l, r, out),
                    (l, r) => out.push((
                        child,
                        l.map_or(json!("<absent>"), short),
                        r.map_or(json!("<absent>"), short),
                    )),
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (l, r)) in a.iter().zip(b).enumerate() {
                differences(&format!("{path}[{i}]"), l, r, out);
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            out.push((format!("{path}.length"), json!(a.len()), json!(b.len())));
            // Still locate the first differing element so the cause is visible.
            for (i, (l, r)) in a.iter().zip(b).enumerate() {
                if l != r {
                    differences(&format!("{path}[{i}]"), l, r, out);
                    break;
                }
            }
        }
        (Value::String(a), Value::String(b)) if a.starts_with("timeline-v3:") => {
            if normalise_cursor(a) != normalise_cursor(b) {
                out.push((path.to_owned(), json!("<cursor>"), json!("<cursor differs>")));
            }
        }
        _ if left == right => {}
        _ => out.push((path.to_owned(), short(left), short(right))),
    }
}

fn trial_display(fixture: &Value) -> TimelineDisplay {
    let display = &fixture["display"];
    TimelineDisplay {
        completed_turn_display: match display["completedTurnDisplay"].as_str() {
            Some("flat") => CompletedTurnDisplay::Flat,
            _ => CompletedTurnDisplay::Collapse,
        },
        include_diagnostic_operations: display["includeDiagnosticOperations"] == true,
        provider_display_name: display["providerDisplayName"].as_str().map(str::to_owned),
    }
}

#[tokio::test]
async fn real_thread_timelines_match_the_typescript_server() {
    let Ok(dir) = std::env::var("BB_TRIAL_DIR") else { return };
    let mut report = std::env::var("BB_TRIAL_REPORT")
        .ok()
        .map(|path| std::fs::File::create(path).expect("BB_TRIAL_REPORT is writable"));
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    let mut table = Vec::new();
    for path in paths {
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let thread_id = fixture["thread"]["id"].as_str().unwrap().to_owned();
        let provider = fixture["thread"]["providerId"].as_str().unwrap_or("?").to_owned();
        let db = open();
        let mut thread = load_fixture(&db, &fixture);
        db.run("UPDATE threads SET provider_id = ? WHERE id = ?", [&provider, &thread_id]).unwrap();
        thread.thread.provider_id = provider.clone();
        if let Some(environment) = fixture["environmentPath"].as_str() {
            thread.environment_path = Some(environment.to_owned());
        }
        let display = trial_display(&fixture);
        let reader = TimelineReader::new(db.clone());
        let mut results: Vec<(String, Vec<Difference>)> = Vec::new();
        for recorded in fixture["timeline"].as_array().unwrap() {
            let mut request = request_for(&recorded["query"]);
            request.display = display.clone();
            // Recordings made with a non-default window budget say which one.
            if let Some(budget) = fixture["eventBudget"].as_i64() {
                request.event_budget = budget;
            }
            let actual = match reader.read_thread_timeline(&thread, &request).await {
                Ok(body) => body,
                Err(error) => json!({ "status": error.status, "error": error_body(&error) }),
            };
            let expected = if recorded["status"] == 200 {
                recorded["body"].clone()
            } else {
                json!({ "status": recorded["status"], "error": recorded["body"] })
            };
            let mut found = Vec::new();
            differences("$", &actual, &expected, &mut found);
            results.push((recorded["query"].to_string(), found));
        }
        for details in fixture["turnSummaryDetailsList"].as_array().into_iter().flatten() {
            let query = &details["query"];
            let seq = |name: &str| query[name].as_str().unwrap().parse::<i64>().unwrap();
            let request = TurnDetailsRequest {
                display: display.clone(),
                turn_id: query["turnId"].as_str().unwrap().into(),
                source_seq_start: seq("sourceSeqStart"),
                source_seq_end: seq("sourceSeqEnd"),
                before_cursor: None,
            };
            let actual = match reader.read_turn_summary_details(&thread, &request).await {
                Ok(body) => body,
                Err(error) => json!({ "status": error.status, "error": error_body(&error) }),
            };
            let mut found = Vec::new();
            differences("$", &actual, &details["body"], &mut found);
            results.push((format!("turn-summary-details {}", query["turnId"]), found));
        }
        let matching = results.iter().filter(|(_, found)| found.is_empty()).count();
        for (query, found) in &results {
            if let Some((path, actual, expected)) = found.first() {
                println!("{thread_id} {query}: first difference at {path}: {actual} vs {expected}");
            }
            for (path, actual, expected) in found {
                if let Some(file) = report.as_mut() {
                    let line = json!({
                        "thread": thread_id, "provider": provider, "query": query,
                        "path": path, "actual": actual, "expected": expected,
                    });
                    writeln!(file, "{line}").unwrap();
                }
            }
        }
        let events = fixture["events"].as_array().map_or(0, Vec::len);
        table.push((thread_id, provider, events, results.len(), matching));
    }
    println!(
        "\n{:<16} {:<12} {:>7} {:>8} {:>9}",
        "thread", "provider", "events", "queries", "matching"
    );
    for (thread, provider, events, queries, matching) in &table {
        println!("{thread:<16} {provider:<12} {events:>7} {queries:>8} {matching:>9}");
    }
    let total: usize = table.iter().map(|row| row.3).sum();
    let matching: usize = table.iter().map(|row| row.4).sum();
    println!("total: {} threads, {total} queries, {matching} matching", table.len());
}
