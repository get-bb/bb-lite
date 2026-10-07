//! Compares `build_event_projection` with the TypeScript `buildEventProjection` output recorded in
//! `tests/fixtures/timeline/*.json` (each file: `compacted` events and, per option set, the
//! recorded `projection`).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use bb_thread_view::build_event_projection::build_event_projection;
use bb_thread_view::types::{Projection, ProjectionOptions, ThreadEventWithMeta};
use serde_json::Value;

/// The first path at which `actual` and `expected` differ, with both values there.
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

fn fixture_paths() -> Vec<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/timeline");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("fixture directory")
        .map(|entry| entry.expect("fixture entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
}

#[test]
fn first_difference_reports_paths() {
    let a = serde_json::json!({ "x": [1, { "y": 2 }], "z": 1 });
    let b = serde_json::json!({ "x": [1, { "y": 3 }], "z": 1.0 });
    assert_eq!(first_difference("$", &a, &b).as_deref(), Some("$.x[1].y: 2 != expected 3"));
    assert_eq!(first_difference("$", &a, &a), None);
}

#[test]
#[ignore = "needs text, tool-activity and operation projection"]
fn projection_matches_typescript() {
    let paths = fixture_paths();
    assert!(!paths.is_empty(), "no timeline fixtures");
    let mut failures = Vec::new();
    let mut cases = 0;
    for path in paths {
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read fixture"))
                .expect("fixture JSON");
        let compacted: Vec<ThreadEventWithMeta> =
            serde_json::from_value(fixture["compacted"].clone()).expect("compacted events");
        for (index, result) in fixture["results"].as_array().expect("results").iter().enumerate() {
            cases += 1;
            let options = options_from_json(&result["options"]);
            let label = format!("{name}[{index}] (threadStatus={})", options.thread_status);
            let outcome =
                catch_unwind(AssertUnwindSafe(|| build_event_projection(&compacted, &options)));
            let projection = match outcome {
                Ok(projection) => projection,
                Err(panic) => {
                    let message = panic
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                        .unwrap_or_default();
                    failures.push(format!("{label}: panicked: {message}"));
                    continue;
                }
            };
            let actual = serde_json::to_value(&projection).expect("serialize projection");
            if let Some(difference) = first_difference("$", &actual, &result["projection"]) {
                failures.push(format!("{label}: {difference}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {cases} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The recorded projections survive a round trip through [`Projection`], so a mismatch in
/// `projection_matches_typescript` is a projection difference, not a serde-shape one.
#[test]
fn recorded_projections_round_trip() {
    let mut failures = Vec::new();
    for path in fixture_paths() {
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read fixture"))
                .expect("fixture JSON");
        for (index, result) in fixture["results"].as_array().expect("results").iter().enumerate() {
            let recorded = &result["projection"];
            let round_tripped = serde_json::from_value::<Projection>(recorded.clone())
                .map_err(|error| error.to_string())
                .and_then(|projection| {
                    serde_json::to_value(&projection).map_err(|error| error.to_string())
                });
            match round_tripped {
                Err(error) => failures.push(format!("{name}[{index}]: {error}")),
                Ok(value) => {
                    if let Some(difference) = first_difference("$", &value, recorded) {
                        failures.push(format!("{name}[{index}]: {difference}"));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
