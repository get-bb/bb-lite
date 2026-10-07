mod support;

use std::path::Path;

use bb_cli::log_text::format_timeline_text;
use bb_thread_view::rows::TimelineRow;
use serde_json::{Value, json};
use support::{Fake, fail, ok};

fn fixture_rows(name: &str) -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/log_text/hand-minimal-plain.json");
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse");
    let cases = fixture["cases"].as_array().expect("cases");
    let case = cases.iter().find(|case| case["name"] == name).expect("case");
    case["rows"].as_array().expect("rows").clone()
}

fn text(rows: &[Value], verbose: bool) -> String {
    let rows: Vec<TimelineRow> = serde_json::from_value(json!(rows)).expect("rows");
    format_timeline_text(&rows, verbose, false)
}

fn page(rows: &[Value], older: Option<(u64, &str)>, returned: u64) -> Value {
    let cursor = older.map(|(seq, id)| json!({ "anchorSeq": seq, "anchorId": id }));
    json!({
        "rows": rows,
        "timelinePage": {
            "segmentLimit": 100,
            "returnedSegmentCount": returned,
            "hasOlderRows": older.is_some(),
            "olderCursor": cursor,
        },
    })
}

fn plain(out: &str) -> String {
    out.replace("\x1b[2m", "").replace("\x1b[22m", "")
}

#[test]
fn thread_log_prints_the_minimal_text() {
    let rows = fixture_rows("single-work-trailing");
    let fake = Fake::json(page(&rows, None, 1));
    let out = ok(&fake.url, None, &["thread", "log", "thr_a"]);
    let request = fake.only();
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("GET", "/threads/thr_a/timeline")
    );
    assert_eq!(request.query, "");
    let expected = "── User ────────────────────────────────────────────────────\nhi\n\n\
                    ── Ran ls ──────────────────────────────────────────────────\n  $ ls\n  \
                    exit 0\n";
    assert_eq!(plain(&out), expected);
}

#[test]
fn thread_log_notices_older_rows_and_sends_the_limit() {
    let rows = fixture_rows("mixed-statuses");
    let fake = Fake::json(page(&rows[4..], Some((7, "x")), 3));
    let out = ok(&fake.url, Some("thr_b"), &["thread", "log", "--self", "--limit", "3"]);
    let request = fake.only();
    assert_eq!(request.path, "/threads/thr_b/timeline");
    assert_eq!(request.query, "segmentLimit=3");
    let notice = "\n\n(Showing the newest 3 user-message turns; use --limit <n> (max 100) or --all \
                  for older history.)\n";
    assert_eq!(plain(&out), format!("{}{notice}", text(&rows[4..], false)));
}

#[test]
fn thread_log_all_follows_the_older_cursor_and_dedupes() {
    let rows = fixture_rows("mixed-statuses");
    let (newest, older) = (rows[6..].to_vec(), rows[..7].to_vec());
    let fake = Fake::start(move |request| {
        let body = if request.query.contains("beforeAnchorId=y") {
            page(&older, None, 1)
        } else {
            page(&newest, Some((12, "y")), 1)
        };
        (200, body.to_string())
    });
    let out = ok(&fake.url, None, &["thread", "log", "thr_a", "--all", "--format", "verbose"]);
    let queries: Vec<String> = fake.requests().into_iter().map(|r| r.query).collect();
    assert_eq!(
        queries,
        [
            "includeNestedRows=true&segmentLimit=100",
            "includeNestedRows=true&segmentLimit=100&beforeAnchorSeq=12&beforeAnchorId=y",
        ]
    );
    assert_eq!(plain(&out), format!("{}\n", text(&rows, true)));
    assert_ne!(text(&rows, true), text(&rows, false));
}

#[test]
fn thread_log_rejects_bad_limits() {
    let fake = Fake::json(json!({}));
    let error = fail(&fake.url, None, &["thread", "log", "thr_a", "--limit", "101"]);
    assert_eq!(
        error.message,
        "--limit is at most 100 for the timeline; use --all for the whole thread."
    );
    let error = fail(&fake.url, None, &["thread", "log", "thr_a", "--all", "--limit", "5"]);
    assert_eq!(error.message, "--all cannot be combined with --limit.");
    let error = fail(&fake.url, None, &["thread", "log", "thr_a", "--after-seq", "5"]);
    assert_eq!(error.message, "--after-seq is only supported with --format json.");
    assert!(fake.requests().is_empty());
}
