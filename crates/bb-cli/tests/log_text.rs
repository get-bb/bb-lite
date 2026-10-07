use std::path::Path;

use bb_cli::log_text::format_timeline_text;
use bb_thread_view::rows::TimelineRow;
use serde_json::Value;

#[test]
fn matches_the_typescript_for_every_recorded_case() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/log_text");
    let mut files: Vec<_> = std::fs::read_dir(&dir).expect("fixtures").flatten().collect();
    files.sort_by_key(|entry| entry.file_name());
    let mut compared = 0;
    let mut failures = Vec::new();
    for entry in files {
        let raw = std::fs::read_to_string(entry.path()).expect("read");
        let fixture: Value = serde_json::from_str(&raw).expect("parse");
        for case in fixture["cases"].as_array().expect("cases") {
            compared += 1;
            let rows: Vec<TimelineRow> =
                serde_json::from_value(case["rows"].clone()).expect("timeline rows");
            let verbose = case["verbose"].as_bool().expect("verbose");
            let color = case["color"].as_bool().expect("color");
            let want = case["text"].as_str().expect("text");
            let text = format_timeline_text(&rows, verbose, color);
            if text != want {
                let (file, name) = (entry.file_name(), &case["name"]);
                failures.push(format!(
                    "{file:?} {name} (verbose={verbose}, color={color})\n--- want\n{want}\n--- got\n{text}"
                ));
            }
        }
    }
    assert!(compared >= 426, "only {compared} cases");
    assert!(
        failures.is_empty(),
        "{} of {compared} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
