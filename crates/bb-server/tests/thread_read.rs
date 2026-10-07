use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::events::{EventSource, append_events};
use bb_server::db::projects::ensure_personal_project;
use bb_server::db::thread_read::find_thread_list_row;
use bb_server::db::{Db, snake_case};
use bb_server::domain::changes::ThreadChangeKind;
use bb_server::http::compression::Uncompressed;
use bb_server::http::routes::thread_read::thread_read_routes;
use bb_server::http::trust::Principal;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::Hub;
use http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Map, Value, json};
use tokio::time::Instant;
use tower::ServiceExt;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/parity");
const BASIC: &str = "thr_926di2adfa";

fn context() -> Ctx {
    let dir = std::env::temp_dir();
    let config = ServerConfig {
        data_dir: dir.clone(),
        port: 0,
        bind_host: "127.0.0.1".into(),
        allowed_hosts: Vec::new(),
        app_dir: dir.clone(),
        cli_dir: dir.clone(),
        bb_cli_path: dir,
        version: "0.0.0".into(),
        host_id: "host_local".into(),
        log_level: LogLevel::Silent,
    };
    let db = Db::open_in_memory(None).unwrap();
    db.run("PRAGMA foreign_keys = OFF", []).unwrap();
    let hub = Hub::new();
    let log = Logger::silent();
    let plugins = PluginHost::new(PluginHostOptions {
        config: config.clone(),
        db: db.clone(),
        hub: hub.clone(),
        log: log.clone(),
        builtins: Some(Vec::new()),
    });
    Arc::new(ServerContext {
        config,
        db,
        hub,
        runners: RunnerRegistry::new("host_local", log.clone()),
        plugins,
        log,
        engine: Default::default(),
        environments: Default::default(),
        terminals: Default::default(),
    })
}

fn read_json(path: &str) -> Value {
    let text = std::fs::read_to_string(format!("{FIXTURES}/{path}")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn recorded(scenario: &str, method: &str, path: &str, query: Value) -> Value {
    let steps = read_json("conversation.json");
    steps
        .as_array()
        .unwrap()
        .iter()
        .find(|step| {
            step["scenario"] == scenario
                && step["request"]["method"] == method
                && step["request"]["path"] == format!("/api/v1{path}")
                && step["request"]["query"] == query
        })
        .unwrap_or_else(|| panic!("no recorded {method} {path}"))["response"]
        .clone()
}

fn literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(flag) => i32::from(*flag).to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => format!("'{}'", text.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

fn insert_row(ctx: &Ctx, table: &str, row: &Map<String, Value>) {
    let columns: Vec<String> = row.keys().map(|key| snake_case(key)).collect();
    let values: Vec<String> = row.values().map(literal).collect();
    let sql =
        format!("INSERT INTO {table} ({}) VALUES ({})", columns.join(", "), values.join(", "));
    ctx.db.exec_batch(&sql).unwrap();
}

/// Seeds the recorded thread row and its stored events up to `max_seq`, keeping recorded ids,
/// sequences and timestamps.
fn seed_thread(ctx: &Ctx, name: &str, max_seq: i64) -> String {
    let fixture = read_json(&format!("threads/{name}.json"));
    let thread = fixture["thread"].as_object().unwrap();
    ensure_personal_project(&ctx.db).unwrap();
    insert_row(ctx, "threads", thread);
    let id = thread["id"].as_str().unwrap().to_owned();
    let row = find_thread_list_row(&ctx.db, &id).unwrap().unwrap().thread;
    for stored in fixture["events"].as_array().unwrap() {
        let seq = stored["meta"]["seq"].as_i64().unwrap();
        if seq > max_seq {
            continue;
        }
        append_events(&ctx.db, &row, std::slice::from_ref(&stored["event"]), EventSource::Server)
            .unwrap();
        let sql = format!(
            "UPDATE events SET id = {}, created_at = {} WHERE thread_id = {} AND sequence = {seq}",
            literal(&stored["meta"]["id"]),
            stored["meta"]["createdAt"],
            literal(&json!(id)),
        );
        ctx.db.exec_batch(&sql).unwrap();
    }
    id
}

async fn call_full(
    ctx: &Ctx,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value, bool) {
    let app = thread_read_routes().with_state(ctx.clone());
    let mut request = Request::builder().method(method).uri(path);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let mut request = request.body(body).unwrap();
    request.extensions_mut().insert(Principal::Owner);
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let uncompressed = response.extensions().get::<Uncompressed>().is_some();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null), uncompressed)
}

async fn get(ctx: &Ctx, path: &str) -> (StatusCode, Value) {
    let (status, body, _) = call_full(ctx, Method::GET, path, None).await;
    (status, body)
}

fn assert_error(response: (StatusCode, Value), status: u16, message: &str) {
    assert_eq!(response.0.as_u16(), status, "{}", response.1);
    assert_eq!(response.1["message"], message);
}

#[tokio::test]
async fn events_and_output_match_recorded_responses() {
    let ctx = context();
    seed_thread(&ctx, "basic", 18);
    let expected = recorded("thread-basics", "GET", &format!("/threads/{BASIC}/events"), json!({}));
    let (status, body) = get(&ctx, &format!("/threads/{BASIC}/events")).await;
    assert_eq!(status.as_u16(), expected["status"].as_u64().unwrap() as u16);
    assert_eq!(body, expected["body"]);

    let expected = recorded("thread-basics", "GET", &format!("/threads/{BASIC}/output"), json!({}));
    assert_eq!(get(&ctx, &format!("/threads/{BASIC}/output")).await.1, expected["body"]);

    let (_, page) =
        get(&ctx, &format!("/threads/{BASIC}/events?afterSeq=2&limit=3&order=desc")).await;
    let seqs: Vec<i64> =
        page.as_array().unwrap().iter().map(|row| row["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, vec![18, 17, 16]);
    let typed = get(&ctx, &format!("/threads/{BASIC}/events?types=client/turn/requested")).await.1;
    assert!(typed.as_array().unwrap().iter().all(|row| row["type"] == "client/turn/requested"));
}

#[tokio::test]
async fn validates_event_queries() {
    let ctx = context();
    seed_thread(&ctx, "basic", 3);
    let events = format!("/threads/{BASIC}/events");
    assert_error(
        get(&ctx, &format!("{events}?limit=101")).await,
        400,
        "Thread event limit cannot exceed 100",
    );
    assert_error(get(&ctx, &format!("{events}?limit=0")).await, 400, "limit must be positive");
    assert_error(
        get(&ctx, &format!("{events}?types=nope")).await,
        400,
        "Invalid thread event types",
    );
    assert_error(
        get(&ctx, &format!("{events}?afterSeq=x")).await,
        400,
        "Invalid string: must match pattern /^\\d+$/",
    );
    assert_error(get(&ctx, "/threads/thr_doesnotexist/events").await, 404, "Thread not found");
}

#[tokio::test]
async fn prompt_history_matches_recorded_shape() {
    let ctx = context();
    seed_thread(&ctx, "basic", 27);
    let path = format!("/threads/{BASIC}/prompt-history");
    let expected = recorded("thread-basics", "GET", &path, json!({}));
    let (status, body) = get(&ctx, &path).await;
    assert_eq!(status, StatusCode::OK);
    let entry = &body[0];
    let want = &expected["body"][0];
    let keys = |value: &Value| {
        value.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>()
    };
    assert_eq!(keys(entry), keys(want));
    assert_eq!(entry["input"], want["input"]);
    assert_error(get(&ctx, &format!("{path}?limit=0")).await, 400, "limit must be positive");
}

#[tokio::test]
async fn search_validates_and_matches_recorded_shape() {
    let ctx = context();
    seed_thread(&ctx, "basic", 27);
    let expected = recorded("search", "GET", "/threads/search", json!({ "q": "pineapple" }));
    assert_eq!(get(&ctx, "/threads/search?q=pineapple").await.1, expected["body"]);
    assert_error(
        get(&ctx, "/threads/search?query=d").await,
        400,
        "Too small: expected string to have >=2 characters",
    );
    assert_error(
        get(&ctx, "/threads/search?query=pine&limitPerGroup=51").await,
        400,
        "limitPerGroup must be less than or equal to 50",
    );
    let (status, found) = get(&ctx, "/threads/search?query=pineapple").await;
    assert_eq!(status, StatusCode::OK);
    let recorded = recorded("search", "GET", "/threads/search", json!({ "query": "pineapple" }));
    for group in ["active", "archived"] {
        let keys = |value: &Value| {
            value.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(keys(&found[group]), keys(&recorded["body"][group]));
    }
    let ids: Vec<&Value> =
        found["active"]["results"].as_array().unwrap().iter().map(|r| &r["thread"]["id"]).collect();
    assert_eq!(ids, vec![&json!(BASIC)]);
}

#[tokio::test]
async fn thread_get_and_timeline_errors_match_recorded() {
    let ctx = context();
    let missing = recorded("errors", "GET", "/threads/thr_doesnotexist", json!({}));
    let (status, body) = get(&ctx, "/threads/thr_doesnotexist").await;
    assert_eq!(status.as_u16() as u64, missing["status"].as_u64().unwrap());
    assert_eq!(body, missing["body"]);
    seed_thread(&ctx, "basic", 3);
    let path = format!("/threads/{BASIC}/timeline");
    let query = json!({ "segmentLimit": "abc" });
    let expected = recorded("errors", "GET", &path, query);
    assert_eq!(get(&ctx, &format!("{path}?segmentLimit=abc")).await.1, expected["body"]);
    assert_error(
        get(&ctx, &format!("{path}?segmentLimit=101")).await,
        400,
        "segmentLimit must be less than or equal to 100",
    );
    assert_error(
        get(&ctx, &format!("{path}?segmentLimit=0")).await,
        400,
        "segmentLimit must be a positive integer",
    );
    assert_error(
        get(&ctx, &format!("{path}?beforeAnchorSeq=3")).await,
        400,
        "beforeAnchorSeq and beforeAnchorId must be provided together",
    );
    assert_error(
        get(&ctx, &format!("{path}/turn-summary-details?turnId=t")).await,
        400,
        "Required",
    );
    assert_error(
        get(&ctx, &format!("/threads/{BASIC}?include=bogus")).await,
        400,
        "Invalid include",
    );
    let (status, thread) = get(&ctx, &format!("/threads/{BASIC}?include=environment,host")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(thread["id"], BASIC);
    assert_eq!(thread["environment"], Value::Null);
    assert_eq!(thread["host"], Value::Null);
    assert_eq!(thread["environmentHostName"], Value::Null);
    let summary = get(&ctx, &format!("/threads/{BASIC}/child-summary")).await.1;
    assert_eq!(summary, json!({ "nonDeletedChildCount": 0, "unarchivedDescendantCount": 0 }));
    assert_eq!(get(&ctx, &format!("/threads/{BASIC}/queued-messages")).await.1, json!([]));
    assert_eq!(get(&ctx, &format!("/threads/{BASIC}/interactions")).await.1, json!([]));
    assert_error(
        get(&ctx, &format!("/threads/{BASIC}/interactions/pint_x")).await,
        404,
        "Interaction not found",
    );
}

#[tokio::test]
async fn lists_threads_and_resolves_mentions() {
    let ctx = context();
    seed_thread(&ctx, "basic", 1);
    let (status, listed) = get(&ctx, "/threads").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_error(
        get(&ctx, "/threads?sectionId=s&unsectioned=true").await,
        400,
        "sectionId and unsectioned cannot be used together",
    );
    assert_error(get(&ctx, "/threads?limit=0").await, 400, "limit must be positive");
    ctx.db.exec_batch("UPDATE threads SET title = '  ', title_fallback = NULL").unwrap();
    let payload = json!({ "threadIds": [BASIC, BASIC, "thr_2222222222"] });
    let (_, resolved, _) =
        call_full(&ctx, Method::POST, "/threads/resolve-mentions", Some(payload)).await;
    assert_eq!(
        resolved,
        json!([{ "threadId": BASIC, "projectId": "proj_personal", "label": "Thread thr_926d" }])
    );
    let bad = json!({ "threadIds": ["nope"] });
    assert_eq!(
        call_full(&ctx, Method::POST, "/threads/resolve-mentions", Some(bad)).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test(start_paused = true)]
async fn event_wait_times_out_with_no_content() {
    let ctx = context();
    seed_thread(&ctx, "basic", 2);
    let started = Instant::now();
    let path = format!("/threads/{BASIC}/events/wait?type=turn/completed&waitMs=60000");
    let (status, _, uncompressed) = call_full(&ctx, Method::GET, &path, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(uncompressed);
    assert_eq!(started.elapsed(), Duration::from_secs(30));
    assert_error(
        get(&ctx, &format!("/threads/{BASIC}/events/wait?type=bogus")).await,
        400,
        "Invalid event type",
    );
    assert_error(get(&ctx, &format!("/threads/{BASIC}/events/wait")).await, 400, "Required");
}

#[tokio::test(start_paused = true)]
async fn event_wait_wakes_on_a_thread_change() {
    let ctx = context();
    seed_thread(&ctx, "basic", 1);
    let started = Instant::now();
    let waiter = {
        let ctx = ctx.clone();
        let path = format!("/threads/{BASIC}/events/wait?type=client/turn/requested&afterSeq=1");
        tokio::spawn(async move { call_full(&ctx, Method::GET, &path, None).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    seed_more(&ctx);
    ctx.hub.thread(BASIC, vec![ThreadChangeKind::EventsAppended], None);
    let (status, row, uncompressed) = waiter.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(uncompressed);
    assert_eq!(row["type"], "client/turn/requested");
    assert!(row["seq"].as_i64().unwrap() > 1);
    assert!(started.elapsed() < Duration::from_secs(1));
}

fn seed_more(ctx: &Ctx) {
    let fixture = read_json("threads/basic.json");
    let row = find_thread_list_row(&ctx.db, BASIC).unwrap().unwrap().thread;
    let event = fixture["events"][0]["event"].clone();
    append_events(&ctx.db, &row, &[event], EventSource::Server).unwrap();
}

#[tokio::test]
async fn sidebar_bootstrap_and_project_defaults_match_recorded() {
    let ctx = context();
    seed_thread(&ctx, "basic", 1);
    let expected = recorded("system-and-settings", "GET", "/sidebar-bootstrap", json!({}));
    let (status, body) = get(&ctx, "/sidebar-bootstrap").await;
    assert_eq!(status, StatusCode::OK);
    let kinds = |value: &Value| {
        value
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, field)| (key.clone(), std::mem::discriminant(field)))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    assert_eq!(kinds(&body), kinds(&expected["body"]));
    assert_eq!(body["personalProject"]["id"], "proj_personal");
    assert_eq!(body["personalProject"]["threads"][0]["id"], BASIC);
    assert_eq!(body["projects"], json!([]));

    let path = "/projects/proj_personal/default-execution-options";
    let recorded_defaults = recorded(
        "projects",
        "GET",
        "/projects/proj_z6sdsqqsxh/default-execution-options",
        json!({}),
    );
    assert_eq!(get(&ctx, path).await, (StatusCode::OK, recorded_defaults["body"].clone()));
    assert_eq!(
        get(&ctx, "/projects/proj_missing/default-execution-options").await.0,
        StatusCode::NOT_FOUND
    );
    let (status, history) = get(&ctx, "/projects/proj_personal/prompt-history").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history[0]["input"][0]["text"], "hello pineapple world");
}

fn seed_plain_thread(ctx: &Ctx, id: &str, title: &str, archived_at: Option<i64>) {
    ensure_personal_project(&ctx.db).unwrap();
    let row = json!({
        "id": id, "projectId": "proj_personal", "providerId": "codex", "title": title,
        "status": "idle", "latestAttentionAt": 1, "createdAt": 1, "updatedAt": 1,
        "archivedAt": archived_at,
    });
    insert_row(ctx, "threads", row.as_object().unwrap());
}

#[tokio::test]
async fn search_ranks_threads_and_returns_highlight_ranges() {
    let ctx = context();
    seed_plain_thread(&ctx, "thr_1", "Deploy pipeline", None);
    seed_plain_thread(&ctx, "thr_2", "Notes", Some(5));
    let filler = "lorem ipsum dolor sit amet ".repeat(8);
    let long = format!("{filler}fix the déploy pipeline today {filler}");
    let segments = [
        ("thr_1", "title", "Deploy pipeline"),
        ("thr_1", "user_message", long.as_str()),
        ("thr_2", "assistant_message", "deploy notes"),
    ];
    for (index, (thread_id, source_kind, text)) in segments.into_iter().enumerate() {
        let row = json!({
            "threadId": thread_id, "sourceKind": source_kind, "text": text, "sourceSeq": index,
            "id": format!("seg_{index}"), "sourceKey": format!("k{index}"),
            "createdAt": 1, "updatedAt": 1,
        });
        insert_row(&ctx, "thread_search_segments", row.as_object().unwrap());
    }
    let (status, found) = get(&ctx, "/threads/search?query=deploy%20pipe").await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["archived"], json!({ "total": 0, "results": [] }));
    assert_eq!(found["active"]["total"], 1);
    let matches = found["active"]["results"][0]["matches"].as_array().unwrap();
    let spans: Vec<String> = matches[0]["highlightRanges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|range| format!("{},{}", range["start"], range["end"]))
        .collect();
    assert_eq!(spans.join(" "), "0,6 7,11");
    let text: Vec<char> = matches[1]["text"].as_str().unwrap().chars().collect();
    let marked: Vec<String> = matches[1]["highlightRanges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|range| {
            let (start, end) = (range["start"].as_u64().unwrap(), range["end"].as_u64().unwrap());
            text[start as usize..end as usize].iter().collect()
        })
        .collect();
    assert_eq!(marked, vec!["déploy", "pipe"]);
    let broad = get(&ctx, "/threads/search?query=deploy").await.1;
    let archived: Vec<&Value> = broad["archived"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| &r["thread"]["id"])
        .collect();
    assert_eq!(archived, vec![&json!("thr_2")]);
    assert_eq!(get(&ctx, "/threads/search?query=d").await.0, StatusCode::BAD_REQUEST);
}
