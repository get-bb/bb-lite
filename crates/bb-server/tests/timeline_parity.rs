#[path = "timeline_window_support.rs"]
mod support;

use bb_server::threads::timeline::{TimelineReader, TurnDetailsRequest};
use serde_json::Value;
use support::*;

fn compare(label: &str, actual: &Value, expected: &Value) {
    if let Some(difference) = first_difference("$", actual, expected) {
        panic!("{label}: first difference at {difference}");
    }
}

#[tokio::test]
async fn stale_row_id_cursors_are_rejected_like_the_recording() {
    for (name, fixture) in fixtures() {
        let db = open();
        let thread = load_fixture(&db, &fixture);
        let reader = TimelineReader::new(db);
        for recorded in fixture["timeline"].as_array().unwrap() {
            if recorded["status"] != 400 {
                continue;
            }
            let request = request_for(&recorded["query"]);
            let error = reader.read_thread_timeline(&thread, &request).await.unwrap_err();
            assert_eq!(error.status, 400, "{name}");
            compare(&name, &error_body(&error), &recorded["body"]);
        }
    }
}

#[tokio::test]
#[ignore = "needs the projection handlers"]
async fn timeline_responses_match_the_typescript_server() {
    for (name, fixture) in fixtures() {
        let db = open();
        let thread = load_fixture(&db, &fixture);
        let reader = TimelineReader::new(db.clone());
        for recorded in fixture["timeline"].as_array().unwrap() {
            let label = format!("{name} {}", recorded["query"]);
            let request = request_for(&recorded["query"]);
            match reader.read_thread_timeline(&thread, &request).await {
                Ok(body) => compare(&label, &body, &recorded["body"]),
                Err(error) if recorded["status"] == 200 => {
                    panic!("{label}: {} {:?}", error.body.message, error.body)
                }
                Err(error) => compare(&label, &error_body(&error), &recorded["body"]),
            }
        }
        let details = &fixture["turnSummaryDetails"];
        if details.is_null() {
            continue;
        }
        let rows = fixture["timeline"][0]["body"]["rows"].as_array().unwrap();
        let turn = rows.iter().find(|row| row["kind"] == "turn").unwrap();
        let request = TurnDetailsRequest {
            display: display(),
            turn_id: turn["turnId"].as_str().unwrap().into(),
            source_seq_start: turn["sourceSeqStart"].as_i64().unwrap(),
            source_seq_end: turn["sourceSeqEnd"].as_i64().unwrap(),
            before_cursor: None,
        };
        let body = reader.read_turn_summary_details(&thread, &request).await.unwrap();
        compare(&format!("{name} turn-summary-details"), &body, details);
    }
}
