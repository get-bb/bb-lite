#![allow(dead_code)]

use std::path::PathBuf;

use bb_server::db::Db;
use bb_server::db::thread_read::{ThreadListRow, find_thread_list_row};
use bb_server::domain::events::{
    event_data, event_item_id, event_item_kind, event_parent_tool_call_id,
    event_provider_thread_id, event_scope_kind, event_turn_id, event_type,
};
use bb_server::threads::timeline::{TimelineDisplay, TimelineRequest};
use bb_server::threads::timeline_pages::{TimelinePage, TimelinePaginationCursor};
use bb_thread_view::group_turns::CompletedTurnDisplay;
use serde_json::{Value, json};

pub fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/parity/threads")
}

pub fn fixtures() -> Vec<(String, Value)> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(fixture_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            (name, serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap())
        })
        .collect()
}

pub fn open() -> Db {
    let db = Db::open_in_memory(None).unwrap();
    db.run(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_demo', 'demo', 1, 1)",
        [],
    )
    .unwrap();
    db
}

pub fn insert_thread(db: &Db, id: &str, status: &str, title: Option<&str>, fallback: Option<&str>) {
    db.run(
        "INSERT INTO threads (id, project_id, provider_id, title, title_fallback, status,
           latest_attention_at, created_at, updated_at)
         VALUES (?, 'proj_demo', 'echo', ?, ?, ?, 1, 1, 1)",
        rusqlite::params![id, title, fallback, status],
    )
    .unwrap();
}

/// Stores a decoded event the way `append_events` derives the columns.
pub fn store(db: &Db, thread_id: &str, id: &str, sequence: i64, created_at: i64, event: &Value) {
    db.run(
        "INSERT INTO events (id, thread_id, scope_kind, turn_id, provider_thread_id, sequence,
           type, item_id, item_kind, parent_tool_call_id, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            id,
            thread_id,
            event_scope_kind(event).unwrap_or("thread"),
            event_turn_id(event),
            event_provider_thread_id(event),
            sequence,
            event_type(event),
            event_item_id(event),
            event_item_kind(event),
            event_parent_tool_call_id(event),
            Value::Object(event_data(event)).to_string(),
            created_at,
        ],
    )
    .unwrap();
}

/// Appends `event` (with `scope` and `type`) at the next sequence.
pub fn append(db: &Db, thread_id: &str, event: Value) -> i64 {
    let sequence = bb_server::db::event_read::latest_sequence(db, thread_id).unwrap() + 1;
    let id = format!("evt_{thread_id}_{sequence}");
    store(db, thread_id, &id, sequence, 1000 + sequence, &event);
    sequence
}

pub fn thread_row(db: &Db, id: &str, environment_path: Option<String>) -> ThreadListRow {
    let mut row = find_thread_list_row(db, id).unwrap().unwrap();
    row.environment_path = environment_path;
    row
}

/// The recorded workspace path, read back from a recorded `historySnapshot` surface.
pub fn recorded_environment_path(fixture: &Value) -> Option<String> {
    let snapshot = fixture["timeline"][0]["body"]["timelinePage"]["historySnapshot"].as_str()?;
    let snapshot: Value = serde_json::from_str(snapshot).ok()?;
    let surface: Value = serde_json::from_str(snapshot["surface"].as_str()?).ok()?;
    surface[5].as_str().map(str::to_string)
}

pub fn load_fixture(db: &Db, fixture: &Value) -> ThreadListRow {
    let thread = &fixture["thread"];
    let id = thread["id"].as_str().unwrap();
    insert_thread(
        db,
        id,
        thread["status"].as_str().unwrap(),
        thread["title"].as_str(),
        thread["titleFallback"].as_str(),
    );
    for entry in fixture["events"].as_array().unwrap() {
        let meta = &entry["meta"];
        let (seq, created) = (meta["seq"].as_i64().unwrap(), meta["createdAt"].as_i64().unwrap());
        store(db, id, meta["id"].as_str().unwrap(), seq, created, &entry["event"]);
    }
    thread_row(db, id, recorded_environment_path(fixture))
}

pub fn display() -> TimelineDisplay {
    TimelineDisplay {
        completed_turn_display: CompletedTurnDisplay::Collapse,
        include_diagnostic_operations: false,
        provider_display_name: Some("Echo".into()),
    }
}

/// The request the route builds for a recorded query.
pub fn request_for(query: &Value) -> TimelineRequest {
    let text = |key: &str| query.get(key).and_then(Value::as_str);
    let segment_limit = text("segmentLimit").map_or(20, |v| v.parse().unwrap());
    let page = match (text("beforeAnchorSeq"), text("beforeAnchorId")) {
        (Some(seq), Some(id)) => TimelinePage::Older {
            segment_limit,
            before_cursor: TimelinePaginationCursor {
                anchor_seq: seq.parse().unwrap(),
                anchor_id: id.into(),
            },
        },
        _ => TimelinePage::Latest { segment_limit },
    };
    TimelineRequest {
        display: display(),
        page,
        include_nested_rows: text("includeNestedRows") == Some("true"),
        summary_only: text("summaryOnly") == Some("true"),
        event_budget: 1_500,
        after_sequence: text("afterSequence").map(|v| v.parse().unwrap()),
    }
}

pub fn first_difference(path: &str, left: &Value, right: &Value) -> Option<String> {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|key| {
                let (l, r) =
                    (a.get(key).unwrap_or(&Value::Null), b.get(key).unwrap_or(&Value::Null));
                if a.contains_key(key) != b.contains_key(key) {
                    return Some(format!("{path}.{key}: {l} vs {r}"));
                }
                first_difference(&format!("{path}.{key}"), l, r)
            })
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .enumerate()
            .find_map(|(i, (l, r))| first_difference(&format!("{path}[{i}]"), l, r)),
        _ if left == right => None,
        _ => Some(format!("{path}: {left} vs {right}")),
    }
}

pub fn error_body(error: &bb_server::error::ApiError) -> Value {
    json!({ "code": error.body.code, "message": error.body.message })
}
