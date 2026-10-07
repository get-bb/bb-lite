//! `build_timeline_row_title` against `fixtures/timeline_row_title/*.json`, produced by the
//! TypeScript `buildTimelineRowTitle` for every view row (and nested child) that
//! `buildTimelineViewRows` builds from each case's timeline rows, under each title option set.

use std::path::PathBuf;

use bb_thread_view::rows::TimelineRow;
use bb_thread_view::timeline_row_title::{TimelineTitleOptions, build_timeline_row_title};
use bb_thread_view::timeline_view::{SummaryChild, ViewRow, build_timeline_view_rows};
use serde_json::Value;

const SHOWN_MISMATCHES: usize = 15;

fn resolve(rows: &[ViewRow], path: &[usize]) -> Option<ViewRow> {
    let (first, rest) = path.split_first()?;
    let mut node = rows.get(*first)?.clone();
    for &index in rest {
        node = match &node {
            ViewRow::Turn(turn) => turn.children.as_ref()?.get(index)?.clone(),
            ViewRow::Work(work) => work.child_rows.get(index)?.clone(),
            ViewRow::Summary(summary) => match summary.children.get(index)? {
                SummaryChild::Work(work) => ViewRow::Work(work.clone()),
                SummaryChild::Reasoning(system) => ViewRow::System(system.clone()),
            },
            ViewRow::Conversation(_) | ViewRow::System(_) => return None,
        };
    }
    Some(node)
}

fn check_fixture(file_name: &str) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/timeline_row_title")
        .join(file_name);
    let text = std::fs::read_to_string(&path).expect("read fixture");
    let file: Value = serde_json::from_str(&text).expect("fixture json");
    let cases = file["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "{file_name} has no cases");

    let mut compared = 0usize;
    let mut mismatches = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let rows: Vec<TimelineRow> = match serde_json::from_value(case["rows"].clone()) {
            Ok(rows) => rows,
            Err(error) => {
                mismatches.push(format!("{name}: rows do not deserialize: {error}"));
                continue;
            }
        };
        let view_rows = build_timeline_view_rows(&rows);
        for entry in case["titles"].as_array().expect("titles") {
            compared += 1;
            let path: Vec<usize> =
                serde_json::from_value(entry["path"].clone()).expect("path indices");
            let options: TimelineTitleOptions =
                serde_json::from_value(entry["options"].clone()).expect("options");
            let location = format!("{name} {:?} {}", path, entry["options"]);
            let Some(node) = resolve(&view_rows, &path) else {
                mismatches.push(format!("{location}: no view row at path"));
                continue;
            };
            let title = build_timeline_row_title(&node, &options);
            let actual = serde_json::to_value(&title).expect("serialize title");
            if actual != entry["title"] {
                mismatches.push(format!(
                    "{location}\n    expected {}\n    actual   {}",
                    entry["title"], actual
                ));
            }
        }
    }
    println!("{file_name}: compared {compared} titles across {} cases", cases.len());
    assert!(
        mismatches.is_empty(),
        "{file_name}: {} of {compared} titles differ; first {}:\n{}",
        mismatches.len(),
        SHOWN_MISMATCHES.min(mismatches.len()),
        mismatches.iter().take(SHOWN_MISMATCHES).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn golden_titles_match_typescript() {
    check_fixture("goldens.json");
}

#[test]
fn work_row_titles_match_typescript() {
    check_fixture("hand_work.json");
}

#[test]
fn structural_row_titles_match_typescript() {
    check_fixture("hand_structure.json");
}

#[test]
fn view_fixture_titles_match_typescript() {
    check_fixture("view_hand.json");
}
