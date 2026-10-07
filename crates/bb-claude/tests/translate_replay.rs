mod translate_support;

use serde_json::Value;
use translate_support::{
    Harness, first_difference, intern_ids, kept, merge_deltas, read_lines, root,
};

const SDK_SCENARIOS: [&str; 10] = [
    "approval-allow",
    "approval-deny",
    "auth-failure",
    "resume",
    "steer-compaction",
    "stop-interrupt",
    "subagent",
    "turn-tools",
    "user-question",
    "web-search",
];
const RAW_SCENARIOS: [&str; 9] = [
    "approval-allow",
    "approval-deny",
    "claude-recorder",
    "dynamic-tool",
    "interrupt",
    "resume",
    "simple",
    "steer",
    "tool-auto-approved",
];

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

fn replay_sdk(scenario: &str) -> Option<String> {
    let dir = root().join("../../packages/runner/test/fixtures/claude");
    let steps = read_lines(&dir.join(format!("{scenario}.wire.ndjson")));
    let mut harness = Harness::new();
    for (index, step) in steps.iter().enumerate() {
        if let Some(open) = step.get("open") {
            let fresh = format!("minted-session-{index}");
            let session = str_at(open, "/0/providerThreadId").unwrap_or(&fresh);
            harness.open(session, str_at(open, "/1/model"), false);
        }
        if let Some(stop) = step.get("stop") {
            harness.stop(stop.as_str() == Some("interrupt"));
        }
        if let Some(turn) = step.get("turn") {
            harness.submit(str_at(turn, "/clientRequestId"));
        }
        if let Some(message) = step.get("message") {
            harness.receive(message);
        }
    }
    harness.close();
    let raw = std::fs::read_to_string(dir.join(format!("{scenario}.events.json"))).ok()?;
    let recorded: Vec<Value> = serde_json::from_str(&raw).ok()?;
    let ours = intern_ids(&merge_deltas(kept(harness.events.lock().clone(), &[])));
    first_difference(&ours, &intern_ids(&merge_deltas(kept(recorded, &[]))))
}

fn replay_raw(scenario: &str) -> Option<String> {
    let dir = root().join("tests/fixtures/raw").join(scenario);
    let meta: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).ok()?).ok()?;
    let mut harness = Harness::new();
    let spawns = std::iter::once(dir.clone())
        .chain((2..).map(|n| dir.join(format!("spawn-{n}"))).take_while(|spawn| spawn.is_dir()));
    for spawn in spawns {
        let lines = read_lines(&spawn.join("interleaved.ndjson"));
        let first_session = lines
            .iter()
            .filter(|e| str_at(e, "/dir") != Some("in"))
            .find_map(|e| str_at(e, "/line/session_id"));
        let session = first_session.or(str_at(&meta, "/providerThreadId")).unwrap_or("session");
        let argv = std::fs::read_to_string(spawn.join("argv.txt")).unwrap_or_default();
        let sandboxed = argv.contains(r#""sandbox":{"enabled":true"#);
        harness.open(session, str_at(&meta, "/model"), sandboxed);
        for entry in lines {
            let Some(line) = entry.get("line") else { continue };
            if str_at(&entry, "/dir") == Some("in") {
                if str_at(line, "/type") == Some("user") {
                    harness.submit(None);
                }
                if str_at(line, "/request/subtype") == Some("interrupt") {
                    harness.stop(true);
                }
            } else {
                harness.receive(line);
            }
        }
    }
    harness.close();
    let raw = std::fs::read_to_string(dir.join("events.json")).ok()?;
    let runner: Vec<Value> = serde_json::from_str(&raw).ok()?;
    let recorded: Vec<Value> = runner
        .iter()
        .filter(|e| str_at(e, "/kind") == Some("thread.events"))
        .filter_map(|e| e.get("events").and_then(Value::as_array))
        .flatten()
        .cloned()
        .collect();
    let excluded = ["turn/input/accepted", "provider.env-resolved"];
    let ours = intern_ids(&merge_deltas(kept(harness.events.lock().clone(), &excluded)));
    first_difference(&ours, &intern_ids(&merge_deltas(kept(recorded, &excluded))))
}

fn report(label: &str, scenarios: &[&str], replay: fn(&str) -> Option<String>) -> Vec<String> {
    let mut failed = Vec::new();
    for scenario in scenarios {
        match replay(scenario) {
            None => println!("{label} {scenario}: match"),
            Some(difference) => {
                println!("{label} {scenario}: MISMATCH at {difference}");
                failed.push(scenario.to_string());
            }
        }
    }
    failed
}

#[test]
fn sdk_fixtures_replay() {
    let failed = report("sdk", &SDK_SCENARIOS, replay_sdk);
    assert!(failed.is_empty(), "mismatched: {failed:?}");
}

#[test]
fn raw_fixtures_replay() {
    let failed = report("raw", &RAW_SCENARIOS, replay_raw);
    assert!(failed.is_empty(), "mismatched: {failed:?}");
}
