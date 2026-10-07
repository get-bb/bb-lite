//! `build_timeline_view_rows` and `build_timeline_work_summary_label` against
//! `fixtures/timeline_view/*.json`, produced by the TypeScript `buildTimelineViewRows` and
//! `buildTimelineWorkSummaryLabel` from the golden timeline rows and hand-built row lists. Key order
//! is compared only for summary rows: the order of the other keys comes from `rows.rs`.

use std::path::PathBuf;

use bb_thread_view::rows::TimelineRow;
use bb_thread_view::timeline_view::{
    ViewRow, WorkSummaryRow, build_timeline_view_rows, build_timeline_work_summary_label,
};
use serde_json::{Value, json};

fn cases() -> Vec<Value> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/timeline_view");
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("fixture dir")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .flat_map(|path| {
            let text = std::fs::read_to_string(&path).expect("read fixture");
            let file: Value = serde_json::from_str(&text).expect("fixture json");
            file["cases"].as_array().expect("cases").clone()
        })
        .collect()
}

fn first_difference(path: &str, actual: &Value, expected: &Value) -> Option<String> {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => {
            let mut a_keys: Vec<&String> = a.keys().collect();
            let mut e_keys: Vec<&String> = e.keys().collect();
            let is_summary = matches!(
                e.get("kind").and_then(Value::as_str),
                Some("step-summary" | "bundle-summary")
            );
            if !is_summary {
                a_keys.sort();
                e_keys.sort();
            }
            if a_keys != e_keys {
                return Some(format!("{path}: keys {a_keys:?}, expected {e_keys:?}"));
            }
            a.iter()
                .find_map(|(key, value)| first_difference(&format!("{path}.{key}"), value, &e[key]))
        }
        (Value::Array(a), Value::Array(e)) if a.len() == e.len() => a
            .iter()
            .zip(e)
            .enumerate()
            .find_map(|(index, (a, e))| first_difference(&format!("{path}[{index}]"), a, e)),
        _ => (actual != expected).then(|| format!("{path}: actual {actual}, expected {expected}")),
    }
}

fn collect_labels(rows: &[ViewRow], out: &mut Vec<Value>) {
    for row in rows {
        match row {
            ViewRow::Summary(summary) => {
                push_labels(summary, out);
                for child in &summary.children {
                    if let bb_thread_view::timeline_view::SummaryChild::Work(work) = child {
                        collect_labels(&work.child_rows, out);
                    }
                }
            }
            ViewRow::Turn(turn) => {
                collect_labels(turn.children.as_deref().unwrap_or_default(), out)
            }
            ViewRow::Work(work) => collect_labels(&work.child_rows, out),
            ViewRow::Conversation(_) | ViewRow::System(_) => {}
        }
    }
}

fn push_labels(summary: &WorkSummaryRow, out: &mut Vec<Value>) {
    for active in [false, true] {
        let label = build_timeline_work_summary_label(summary, active);
        out.push(json!({ "id": summary.base.id, "active": active, "label": label }));
    }
}

#[test]
fn view_rows_and_labels_match_typescript() {
    let cases = cases();
    assert!(cases.len() > 100, "expected the generated fixtures, found {} cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().expect("name");
        let rows: Vec<TimelineRow> = serde_json::from_value(case["rows"].clone()).expect("rows");
        let input = serde_json::to_value(&rows).expect("serialize rows");
        if let Some(diff) = first_difference("rows", &input, &case["rows"]) {
            failures.push(format!("{name}: input round trip {diff}"));
            continue;
        }
        let view_rows = build_timeline_view_rows(&rows);
        let actual = serde_json::to_value(&view_rows).expect("serialize view rows");
        if let Some(diff) = first_difference("viewRows", &actual, &case["viewRows"]) {
            failures.push(format!("{name}: {diff}"));
            continue;
        }
        let mut labels = Vec::new();
        collect_labels(&view_rows, &mut labels);
        if Value::Array(labels.clone()) != case["summaryLabels"] {
            failures.push(format!("{name}: labels {labels:?}, expected {}", case["summaryLabels"]));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
