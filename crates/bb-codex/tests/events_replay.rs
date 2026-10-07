mod replay;

use replay::{
    SCENARIOS, first_difference, intern_ids, kept, read_original_events, replay_translator,
    replay_translator_with,
};
use serde_json::Value;

fn compare(scenario: &str) -> Option<String> {
    let actual = intern_ids(&replay_translator(scenario), false);
    let expected = intern_ids(&kept(read_original_events(scenario)), false);
    first_difference(&actual, &expected)
}

#[test]
fn recorded_sessions_replay_to_the_original_events() {
    let failures: Vec<String> = SCENARIOS
        .iter()
        .filter_map(|scenario| compare(scenario).map(|diff| format!("{scenario}: {diff}")))
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

const PLUMBING: [&str; 2] = ["thread/identity", "turn/input/accepted"];

fn without_plumbing(events: Vec<Value>) -> Vec<Value> {
    let plumbing = |event: &Value| PLUMBING.contains(&event["type"].as_str().unwrap_or(""));
    events.into_iter().filter(|event| !plumbing(event)).collect()
}

#[test]
fn notifications_alone_replay_to_the_original_events_minus_plumbing() {
    let mut failures = Vec::new();
    for scenario in SCENARIOS {
        let actual = without_plumbing(replay_translator_with(scenario, false));
        let expected = without_plumbing(kept(read_original_events(scenario)));
        let diff = first_difference(&intern_ids(&actual, false), &intern_ids(&expected, false));
        failures.extend(diff.map(|diff| format!("{scenario}: {diff}")));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
