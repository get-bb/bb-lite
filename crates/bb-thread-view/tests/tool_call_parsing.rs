use bb_thread_view::tool_call_parsing::{
    TimelineActivityIntent, extract_shell_command_from_string, parse_shell_command_intents,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    source: String,
    input: String,
    extract_shell_command_from_string: Option<String>,
    parse_shell_command_intents: Value,
    parse_extracted: Value,
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

fn load() -> Fixture {
    let text = include_str!("fixtures/tool_call_parsing.json");
    serde_json::from_str(text).expect("fixture parses")
}

fn intents_json(intents: &[TimelineActivityIntent]) -> Value {
    serde_json::to_value(intents).expect("intents serialize")
}

#[test]
fn matches_typescript_on_every_corpus_entry() {
    let fixture = load();
    assert!(fixture.cases.len() >= 150);
    assert!(fixture.cases.iter().any(|c| c.source == "fixture"));
    let mut failures = Vec::new();
    for case in &fixture.cases {
        let extracted = extract_shell_command_from_string(&case.input);
        if extracted != case.extract_shell_command_from_string {
            failures.push(format!(
                "extract {:?}: rust {:?} ts {:?}",
                case.input, extracted, case.extract_shell_command_from_string
            ));
        }
        let intents = intents_json(&parse_shell_command_intents(Some(&case.input)));
        if intents != case.parse_shell_command_intents {
            failures.push(format!(
                "intents {:?}: rust {} ts {}",
                case.input, intents, case.parse_shell_command_intents
            ));
        }
        let of_extracted = intents_json(&parse_shell_command_intents(
            case.extract_shell_command_from_string.as_deref(),
        ));
        if of_extracted != case.parse_extracted {
            failures.push(format!(
                "intents of extracted {:?}: rust {} ts {}",
                case.input, of_extracted, case.parse_extracted
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        fixture.cases.len(),
        failures.join("\n")
    );
}

#[test]
fn intents_round_trip_through_json() {
    for case in load().cases {
        let parsed: Vec<TimelineActivityIntent> =
            serde_json::from_value(case.parse_shell_command_intents.clone()).expect("decodes");
        assert_eq!(intents_json(&parsed), case.parse_shell_command_intents);
    }
}

#[test]
fn none_and_empty_commands_have_no_intents() {
    assert!(parse_shell_command_intents(None).is_empty());
    assert!(parse_shell_command_intents(Some("")).is_empty());
    assert_eq!(extract_shell_command_from_string(" \u{a0}\u{feff}"), None);
}
