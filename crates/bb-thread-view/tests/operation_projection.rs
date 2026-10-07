//! The operation, interaction and file-edit messages of `build_event_projection` against the
//! TypeScript projection: the recorded timeline fixtures plus generated lifecycle scenarios in
//! `fixtures/operation_projection` (written by the TypeScript `buildEventProjection`).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use bb_thread_view::build_event_projection::build_event_projection;
use bb_thread_view::types::{ProjectionOptions, ThreadEventWithMeta};
use serde_json::Value;

fn first_difference(path: &str, actual: &Value, expected: &Value) -> Option<String> {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => {
            let mut keys: Vec<&String> = e.keys().chain(a.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|key| {
                let child = format!("{path}.{key}");
                match (a.get(key), e.get(key)) {
                    (Some(av), Some(ev)) => first_difference(&child, av, ev),
                    (None, Some(ev)) => Some(format!("{child}: missing, expected {ev}")),
                    (Some(av), None) => Some(format!("{child}: unexpected {av}")),
                    (None, None) => None,
                }
            })
        }
        (Value::Array(a), Value::Array(e)) => a
            .iter()
            .zip(e)
            .enumerate()
            .find_map(|(index, (av, ev))| first_difference(&format!("{path}[{index}]"), av, ev))
            .or_else(|| {
                (a.len() != e.len())
                    .then(|| format!("{path}: length {} != expected {}", a.len(), e.len()))
            }),
        (Value::Number(a), Value::Number(e)) if a.as_f64() == e.as_f64() => None,
        _ if actual == expected => None,
        _ => Some(format!("{path}: {actual} != expected {expected}")),
    }
}

fn options_from_json(options: &Value) -> ProjectionOptions {
    ProjectionOptions {
        include_diagnostic_operations: options["includeDiagnosticOperations"]
            .as_bool()
            .unwrap_or(false),
        thread_status: options["threadStatus"].as_str().unwrap_or("idle").to_owned(),
        thread_name: options["threadName"].as_str().unwrap_or_default().to_owned(),
    }
}

fn fixture_paths(subdir: &str) -> Vec<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(subdir);
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("fixture directory")
        .map(|entry| entry.expect("fixture entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
}

/// The operation (other than reasoning), interaction and file-edit messages, in order.
fn operation_messages(projection: &Value) -> Value {
    let entries = projection["entries"].as_array().cloned().unwrap_or_default();
    let messages =
        entries.into_iter().flat_map(|entry| match entry["turn"]["messages"].as_array() {
            Some(messages) => messages.clone(),
            None => vec![entry["message"].clone()],
        });
    Value::Array(
        messages
            .filter(|message| match message["kind"].as_str() {
                Some("operation") => message["opType"] != "reasoning",
                Some("interaction" | "file-edit") => true,
                _ => false,
            })
            .collect(),
    )
}

fn compare_fixtures(subdir: &str) -> (usize, Vec<String>) {
    let mut failures = Vec::new();
    let mut cases = 0;
    for path in fixture_paths(subdir) {
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read fixture"))
                .expect("fixture JSON");
        let compacted: Vec<ThreadEventWithMeta> =
            serde_json::from_value(fixture["compacted"].clone()).expect("compacted events");
        for (index, result) in fixture["results"].as_array().expect("results").iter().enumerate() {
            cases += 1;
            let options = options_from_json(&result["options"]);
            let label =
                format!("{subdir}/{name}[{index}] (threadStatus={})", options.thread_status);
            let outcome =
                catch_unwind(AssertUnwindSafe(|| build_event_projection(&compacted, &options)));
            let Ok(projection) = outcome else {
                failures.push(format!("{label}: panicked"));
                continue;
            };
            let actual = serde_json::to_value(&projection).expect("serialize projection");
            let difference = first_difference(
                "$",
                &operation_messages(&actual),
                &operation_messages(&result["projection"]),
            );
            if let Some(difference) = difference {
                failures.push(format!("{label}: {difference}"));
            }
        }
    }
    (cases, failures)
}

#[test]
#[ignore = "needs the text and tool-activity projection ports"]
fn operation_messages_match_typescript() {
    let mut cases = 0;
    let mut failures = Vec::new();
    for subdir in ["operation_projection", "timeline"] {
        let (count, differences) = compare_fixtures(subdir);
        cases += count;
        failures.extend(differences);
    }
    assert!(
        failures.is_empty(),
        "{} of {cases} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    eprintln!("{cases} cases match");
}
