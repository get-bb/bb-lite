use bb_server::domain::thread::ThreadStatus;
use bb_server::threads::timeline_pages::{
    PaginateTimelineArgs, TimelineContentCursor, TimelinePage, TimelinePaginationCursor,
    TimelineSnapshot, bind_cursor, limit_response_outputs, paginate_contents, paginate_timeline,
    snapshot_from_cursor,
};
use serde_json::{Value, json};

fn user(id: &str, seq: i64) -> Value {
    json!({ "id": id, "kind": "conversation", "role": "user", "sourceSeqStart": seq, "sourceSeqEnd": seq })
}

fn work(id: &str, seq: i64) -> Value {
    json!({ "id": id, "kind": "work", "workKind": "command", "output": "", "sourceSeqStart": seq, "sourceSeqEnd": seq })
}

fn rows() -> Vec<Value> {
    vec![user("u1", 1), work("w1", 2), user("u2", 3), work("w2", 4), user("u3", 5), work("w3", 6)]
}

fn args<'a>(rows: &'a [Value], page: &'a TimelinePage) -> PaginateTimelineArgs<'a> {
    PaginateTimelineArgs {
        rows,
        page,
        content_cursor: None,
        max_leaves: 100,
        max_bytes: 1_000_000,
        owned_sequence_start: 1,
        owned_sequence_end: 7,
        known_has_older_segments: None,
    }
}

fn ids(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|row| row["id"].as_str().unwrap()).collect()
}

#[test]
fn latest_page_takes_the_last_segments_split_on_user_messages() {
    let rows = rows();
    let page = TimelinePage::Latest { segment_limit: 2 };
    let window = paginate_timeline(&args(&rows, &page));
    assert_eq!(ids(&window.rows), ["u2", "w2", "u3", "w3"]);
    assert_eq!(window.returned_segment_count, 2);
    assert!(window.has_older_rows);
    let cursor = TimelinePaginationCursor { anchor_seq: 3, anchor_id: "timeline-window:3".into() };
    assert_eq!(window.older_cursor, Some(cursor));
    assert_eq!(window.older_rows_source_seq_end, Some(2));
    assert_eq!(window.content_page, None);
    let all = paginate_timeline(&args(&rows, &TimelinePage::Latest { segment_limit: 10 }));
    assert_eq!(all.rows.len(), 6);
    assert!(!all.has_older_rows);
    assert_eq!(all.older_cursor, None);
}

#[test]
fn leaf_budget_stops_inside_a_segment_with_a_content_cursor() {
    let rows = rows();
    let page = TimelinePage::Latest { segment_limit: 3 };
    let mut limited = args(&rows, &page);
    limited.max_leaves = 3;
    let window = paginate_timeline(&limited);
    assert_eq!(ids(&window.rows), ["w2", "u3", "w3"]);
    assert_eq!(
        window.content_cursor,
        Some(TimelineContentCursor { before_leaf: 1, before_sequence: 5 })
    );
    let content = window.content_page.unwrap();
    assert_eq!((content.anchor_seq, content.start, content.end, content.total), (3, 1, 2, 2));
    assert_eq!(window.older_rows_source_seq_end, Some(3));
    assert_eq!(window.older_row_updates, Some(vec![user("u2", 3)]));
}

#[test]
fn content_pages_respect_the_byte_budget_and_nested_rows() {
    let turn = json!({
        "id": "t", "kind": "turn", "sourceSeqStart": 1, "sourceSeqEnd": 3,
        "children": [work("a", 1), work("b", 2), work("c", 3)]
    });
    let rows = [turn];
    let one = serde_json::to_string(&work("c", 3)).unwrap().len() as i64;
    let page = paginate_contents(&rows, None, 10, one * 2);
    assert_eq!(page.total, 3);
    assert_eq!((page.start, page.end), (2, 3));
    assert_eq!(ids(page.rows[0]["children"].as_array().unwrap()), ["c"]);
    assert_eq!(page.older_rows_source_seq_end, Some(2));
    let first = paginate_contents(&rows, Some(1), 10, 1_000_000);
    assert_eq!((first.start, first.end), (0, 1));
    assert_eq!(first.older_rows_source_seq_end, None);
}

#[test]
fn cursors_round_trip_and_reject_foreign_snapshots() {
    let snapshot = TimelineSnapshot {
        version: 3,
        thread_id: "thr_1".into(),
        max_seq: 10,
        status: ThreadStatus::Idle,
        surface: "web".into(),
    };
    let window = TimelinePaginationCursor { anchor_seq: 4, anchor_id: "timeline-window:4".into() };
    let content = TimelineContentCursor { before_leaf: 2, before_sequence: 6 };
    let bound = bind_cursor(Some(&window), &snapshot, Some(&content)).unwrap();
    assert_eq!(bound.anchor_seq, 4);
    assert!(bound.anchor_id.starts_with("timeline-v3:"));
    let (decoded, decoded_content) = snapshot_from_cursor(&bound, "thr_1", "web").unwrap();
    assert_eq!(decoded, snapshot);
    assert_eq!(decoded_content, Some(content));
    let error = snapshot_from_cursor(&bound, "thr_2", "web").unwrap_err();
    assert_eq!(error.code(), "invalid_request");
    assert_eq!(
        error.body.message,
        "Timeline pagination cursor is no longer available; reload the latest page"
    );
    assert!(snapshot_from_cursor(&window, "thr_1", "web").is_err());
    assert_eq!(bind_cursor(None, &snapshot, None), None);
}

#[test]
fn limits_and_previews_long_outputs() {
    let long = "y".repeat(40_000);
    let response = json!({
        "rows": [{ "id": "w", "kind": "work", "workKind": "command", "output": long, "outputPreview": null }],
        "timelinePage": {}
    });
    let limited = limit_response_outputs(response.clone(), false);
    let output = limited["rows"][0]["output"].as_str().unwrap();
    assert!(output.ends_with("\n…[8,000 more characters truncated]"));
    let previewed = limit_response_outputs(response, true);
    let row = &previewed["rows"][0];
    let output = row["output"].as_str().unwrap();
    assert!(output.contains("\n…[29,035 characters omitted from preview]\n"));
    assert_eq!(row["outputPreview"]["totalChars"], 32_035);
}
