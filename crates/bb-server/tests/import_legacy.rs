use std::collections::HashMap;
use std::path::Path;

use bb_server::config::load_config;
use bb_server::db::Db;
use bb_server::db::thread_read::{ThreadListQuery, list_thread_rows};
use bb_server::import_legacy::{
    ImportLegacyOptions, ImportLegacySummary, ThreadChoice, import_legacy, import_summary_lines,
};
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use serde_json::{Map, Value, json};

const REQUEST: &str = "creq_aaaaaaaaa2";
const ORIGINAL_SQL: &str = "
CREATE TABLE hosts (id text PRIMARY KEY, name text, type text, destroyed_at
  integer, max_permission_mode text DEFAULT 'full', created_at integer,
  updated_at integer);
CREATE TABLE projects (id text PRIMARY KEY, name text, created_at integer,
  updated_at integer);
CREATE TABLE project_execution_defaults (project_id text, provider_id text,
  model text, service_tier text, reasoning_level text, permission_mode text);
CREATE TABLE project_sources (id text PRIMARY KEY, project_id text,
  host_id text, path text, created_at integer, updated_at integer);
CREATE TABLE environments (id text PRIMARY KEY, project_id text, host_id text,
  path text, status text DEFAULT 'provisioning', provider_owns_path integer,
  created_at integer, updated_at integer);
CREATE TABLE thread_sections (id text PRIMARY KEY, name text,
  created_at integer, updated_at integer);
CREATE TABLE threads (id text PRIMARY KEY, project_id text, environment_id text,
  provider_id text, title text, status text, parent_thread_id text,
  source_thread_id text, lifecycle_owner_thread_id text, origin_kind text,
  section_id text, archived_at integer, deleted_at integer, last_read_at
  integer, latest_attention_at integer, created_at integer, updated_at integer);
CREATE TABLE events (id text PRIMARY KEY, thread_id text, environment_id text,
  scope_kind text, turn_id text, provider_thread_id text, sequence integer,
  type text, item_id text, item_kind text, data text, created_at integer,
  parent_tool_call_id text);
CREATE TABLE pending_interactions (id text PRIMARY KEY, thread_id text,
  status text, payload text, status_reason text, created_at integer,
  resolved_at integer, updated_at integer);
CREATE TABLE prompt_history_entries (id text PRIMARY KEY, thread_id text);
CREATE TABLE thread_search_segments (id text PRIMARY KEY, thread_id text);
CREATE TABLE app_settings_values (key text, value text, updated_at integer);
CREATE TABLE app_theme (id text PRIMARY KEY, theme_id text, updated_at integer,
  favicon_color text);
CREATE TABLE ui_preferences (key text PRIMARY KEY, value_json text);
CREATE TABLE plugin_kv (plugin_id text, key text, value text);
INSERT INTO hosts (id, name, type, created_at, updated_at)
  VALUES ('host_old', 'bee', 'persistent', 1, 1);
INSERT INTO projects VALUES ('proj_demo', 'demo', 1, 1);
INSERT INTO thread_sections VALUES ('sec_later', 'Later', 1, 1);
INSERT INTO environments (id, project_id, host_id, created_at, updated_at)
  VALUES ('env_demo', 'proj_demo', 'host_old', 1, 1);
INSERT INTO pending_interactions (id, thread_id, status, payload, created_at,
  updated_at) VALUES ('pint_1', 'thr_busy', 'pending', '{}', 1, 1);";

fn sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => number
            .as_i64()
            .map_or_else(|| SqlValue::Real(number.as_f64().unwrap_or(0.0)), SqlValue::Integer),
        Value::String(text) => SqlValue::Text(text.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn insert_row(sqlite: &Connection, table: &str, values: &Map<String, Value>) {
    let mut statement = sqlite.prepare("SELECT name FROM pragma_table_info(?)").unwrap();
    let columns: Vec<String> = statement
        .query_map([table], |row| row.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .filter(|name| values.contains_key(name))
        .collect();
    let marks = vec!["?"; columns.len()].join(", ");
    let sql = format!("INSERT OR REPLACE INTO {table} ({}) VALUES ({marks})", columns.join(", "));
    let bound: Vec<SqlValue> = columns.iter().map(|name| sql_value(&values[name])).collect();
    sqlite.execute(&sql, rusqlite::params_from_iter(bound)).unwrap();
}

fn seed_thread(sqlite: &Connection, id: &str, overrides: Value) {
    let mut row = json!({
        "id": id, "project_id": "proj_demo", "environment_id": "env_demo",
        "provider_id": "codex", "title": format!("Thread {id}"), "status": "idle",
        "latest_attention_at": 1_000, "last_read_at": 2_000,
        "created_at": 1_000, "updated_at": 1_000,
    });
    let object = row.as_object_mut().unwrap();
    object.extend(overrides.as_object().unwrap().clone());
    insert_row(sqlite, "threads", object);
}

fn append_events(sqlite: &Connection, thread_id: &str, events: &[Value]) {
    let last: Option<i64> = sqlite
        .query_row("SELECT MAX(sequence) FROM events WHERE thread_id = ?", [thread_id], |row| {
            row.get(0)
        })
        .unwrap();
    for (index, event) in events.iter().enumerate() {
        let sequence = last.unwrap_or(0) + index as i64 + 1;
        let data = event.get("data").cloned().unwrap_or_else(|| json!({}));
        let turn_id = event.get("turnId").cloned().unwrap_or(Value::Null);
        let item = &data["item"];
        let first = |a: &Value, b: &Value| if a.is_null() { b.clone() } else { a.clone() };
        let row = json!({
            "id": format!("evt_{thread_id}_{sequence}"),
            "thread_id": thread_id,
            "scope_kind": if turn_id.is_null() { "thread" } else { "turn" },
            "turn_id": turn_id,
            "provider_thread_id": data["providerThreadId"],
            "sequence": sequence,
            "type": event["type"],
            "item_id": first(&item["id"], &data["itemId"]),
            "item_kind": item["type"],
            "parent_tool_call_id": first(&item["parentToolCallId"], &data["parentToolCallId"]),
            "data": data.to_string(),
            "created_at": 1_000 + sequence,
        });
        insert_row(sqlite, "events", row.as_object().unwrap());
    }
}

fn user_request(request_id: &str, text: &str) -> Value {
    json!({ "type": "client/turn/requested", "data": {
        "direction": "outbound", "source": "tell", "initiator": "user",
        "request": { "method": "turn/start", "params": {} },
        "requestId": request_id, "senderThreadId": null,
        "input": [{ "type": "text", "text": text, "mentions": [] }],
        "target": { "kind": "new-turn" },
        "execution": {
            "model": "gpt-test", "permissionMode": "auto", "reasoningLevel": "low",
            "serviceTier": "default", "source": "client/turn/requested",
        },
    }})
}

fn agent_turn(turn_id: &str, request_id: &str, reply: &str) -> Vec<Value> {
    let turn = |kind: &str, data: Value| {
        let mut merged = json!({ "providerThreadId": "provider-thread" });
        merged.as_object_mut().unwrap().extend(data.as_object().unwrap().clone());
        json!({ "type": kind, "turnId": turn_id, "data": merged })
    };
    let message_id = format!("{turn_id}-i1");
    let command = |extra: Value| {
        let mut item = json!({
            "type": "commandExecution", "id": format!("{turn_id}-i0"), "command": "ls",
            "cwd": "/work/demo", "approvalStatus": null,
        });
        item.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        item
    };
    let output = json!({ "status": "completed", "aggregatedOutput": "a.txt\n", "exitCode": 0 });
    vec![
        turn("turn/started", json!({})),
        turn("turn/input/accepted", json!({ "clientRequestId": request_id })),
        turn("item/started", json!({ "item": command(json!({ "status": "pending" })) })),
        turn("item/completed", json!({ "item": command(output) })),
        turn(
            "item/started",
            json!({ "item": { "type": "agentMessage", "id": message_id, "text": "" } }),
        ),
        turn("item/agentMessage/delta", json!({ "itemId": message_id, "delta": reply })),
        turn(
            "item/completed",
            json!({ "item": { "type": "agentMessage", "id": message_id, "text": reply } }),
        ),
        turn("turn/completed", json!({ "status": "completed" })),
    ]
}

fn seed_original(file: &Path) {
    let sqlite = Connection::open(file).unwrap();
    sqlite.pragma_update(None, "journal_mode", "WAL").unwrap();
    sqlite.execute_batch(ORIGINAL_SQL).unwrap();
    seed_thread(&sqlite, "thr_parent", json!({ "section_id": "sec_later" }));
    seed_thread(&sqlite, "thr_child", json!({ "parent_thread_id": "thr_parent" }));
    seed_thread(&sqlite, "thr_busy", json!({ "status": "active" }));
    seed_thread(&sqlite, "thr_archived", json!({ "archived_at": 2_000 }));
    let turn = agent_turn("t1", REQUEST, "answer 1");
    let mut events = vec![
        user_request(REQUEST, "question 1"),
        json!({ "type": "thread/identity", "data": { "providerThreadId": "session-1" } }),
    ];
    events.extend(turn[..6].iter().cloned());
    events.extend(turn[5..].iter().cloned());
    append_events(&sqlite, "thr_parent", &events);
    append_events(&sqlite, "thr_archived", &[user_request(REQUEST, "old")]);
}

const EXTRA_SQL: &str = "
ALTER TABLE ui_preferences ADD COLUMN revision integer;
ALTER TABLE ui_preferences ADD COLUMN updated_at integer;
INSERT INTO ui_preferences VALUES ('sidebar', '{\"w\":1}', 3, 5);
ALTER TABLE plugin_kv ADD COLUMN updated_at integer;
INSERT INTO plugin_kv VALUES ('thread-list', 'preference:sort', '\"recent\"', 7),
  ('thread-list', 'other', '1', 7), ('tasks', 'preference:x', '1', 7);
INSERT INTO app_settings_values VALUES ('streamerMode', 'true', 10),
  ('providerOrder', '[\"codex\"]', 12), ('keybindingOverrides', '{\"a\":\"b\"}', 11),
  ('unknownKey', '1', 13);
INSERT INTO app_theme VALUES ('current', 'dark', 14, 'red');
INSERT INTO project_sources VALUES ('psrc_1', 'proj_demo', 'host_old', '/src/demo', 1, 1);
INSERT INTO project_execution_defaults
  VALUES ('proj_demo', 'codex', 'gpt-5', 'fast', 'high', 'auto');
INSERT INTO hosts (id, name, type, destroyed_at, created_at, updated_at)
  VALUES ('host_other', 'far', 'ssh', 5, 2, 2);
INSERT INTO environments VALUES ('env_gone', 'proj_demo', 'host_other', '/x', 'destroyed', 1, 1, 1);
INSERT INTO pending_interactions VALUES ('pint_2', 'thr_err', 'resolved', '{}', 'ok', 1, 9, 1);
ALTER TABLE prompt_history_entries ADD COLUMN project_id text;
ALTER TABLE prompt_history_entries ADD COLUMN scope text;
ALTER TABLE prompt_history_entries ADD COLUMN request_sequence integer;
ALTER TABLE prompt_history_entries ADD COLUMN input text;
ALTER TABLE prompt_history_entries ADD COLUMN created_at integer;
INSERT INTO prompt_history_entries VALUES ('ph_1', 'thr_err', 'proj_demo', 'thread', 1, 'hi', 3);
ALTER TABLE thread_search_segments ADD COLUMN source_kind text;
ALTER TABLE thread_search_segments ADD COLUMN source_key text;
ALTER TABLE thread_search_segments ADD COLUMN text text;
ALTER TABLE thread_search_segments ADD COLUMN created_at integer;
ALTER TABLE thread_search_segments ADD COLUMN updated_at integer;
INSERT INTO thread_search_segments VALUES ('seg_1', 'thr_err', 'title', 'k', 'hello there', 3, 3);";

fn seed_extras(source: &Path) {
    let sqlite = Connection::open(source.join("bb.db")).unwrap();
    sqlite.execute_batch(EXTRA_SQL).unwrap();
    let error = json!({ "status": "error", "environment_id": "env_gone", "origin_kind": "fork",
        "source_thread_id": "thr_missing", "lifecycle_owner_thread_id": "thr_parent" });
    seed_thread(&sqlite, "thr_err", error);
    seed_thread(&sqlite, "thr_deleted", json!({ "deleted_at": 5 }));
    let clear = json!({ "status": "completed", "operation": "context_clear" });
    append_events(
        &sqlite,
        "thr_err",
        &[
            json!({ "type": "thread/identity", "data": { "providerThreadId": "session-a" } }),
            json!({ "type": "system/operation", "data": clear }),
            json!({ "type": "item/reasoning/summaryTextDelta", "data": { "delta": "x" } }),
            json!({ "type": "item/completed", "data": {} }),
            json!({ "type": "item/reasoning/summaryTextDelta", "data": { "delta": "y" } }),
        ],
    );
    append_events(&sqlite, "thr_deleted", &[user_request(REQUEST, "gone")]);
    std::fs::write(source.join("host-id"), "host_other\n").unwrap();
}

fn env_for(data_dir: &Path) -> HashMap<String, String> {
    HashMap::from([
        ("BB_DATA_DIR".to_owned(), data_dir.display().to_string()),
        ("BB_SERVER_PORT".to_owned(), "0".to_owned()),
    ])
}

async fn run(
    from: &Path,
    data_dir: &Path,
    threads: ThreadChoice,
    dry_run: bool,
) -> ImportLegacySummary {
    let options = ImportLegacyOptions {
        from: from.display().to_string(),
        threads,
        dry_run,
        env: Some(env_for(data_dir)),
    };
    import_legacy(options).await.unwrap()
}

fn column(db: &Db, sql: &str) -> Vec<Value> {
    let rows = db.rows(sql, []).unwrap();
    rows.into_iter().map(|row| row.into_iter().next().unwrap().1).collect()
}

fn numbers(summary: &ImportLegacySummary, kind: &str) -> Value {
    serde_json::to_value(&summary.counts[kind]).unwrap()
}

#[tokio::test]
async fn moves_an_original_install_into_a_fresh_data_directory() {
    let temp = tempfile::Builder::new().prefix("bb-original-").tempdir().unwrap();
    let from = temp.path();
    let data_dir = from.join("imported");
    let file = from.join("bb.db");
    seed_original(&file);
    let untouched =
        (std::fs::read(&file).unwrap(), std::fs::metadata(&file).unwrap().modified().unwrap());
    let dry = run(from, &data_dir, ThreadChoice::Active, true).await;
    assert_eq!([dry.choices["all"]["threads"], dry.choices["active"]["threads"]], [4, 3]);
    assert!(!data_dir.exists());
    assert_eq!(
        import_summary_lines(&dry)[0],
        format!("Dry run of {}: nothing written. By --threads choice:", from.display())
    );
    let first = run(from, &data_dir, ThreadChoice::Active, false).await;
    assert_eq!(numbers(&first, "events"), json!({ "imported": 10, "skipped": 0, "pruned": 1 }));
    let rerun = run(from, &data_dir, ThreadChoice::Active, false).await;
    let imported: Vec<_> = rerun.counts.values().filter(|tally| tally["imported"] != 0).collect();
    assert!(imported.is_empty(), "{imported:?}");
    let now =
        (std::fs::read(&file).unwrap(), std::fs::metadata(&file).unwrap().modified().unwrap());
    assert!(now == untouched);
    let summary = serde_json::to_value(&first).unwrap();
    let keys: Vec<&String> = summary.as_object().unwrap().keys().collect();
    let expected =
        ["dryRun", "from", "threads", "choices", "counts", "dataDir", "notImported", "elapsedMs"];
    assert_eq!(keys, expected);
    assert_eq!(summary["threads"], "active");

    let host_id = load_config(&env_for(&data_dir)).unwrap().host_id;
    let db = Db::open(&data_dir.join("bb.db"), None).unwrap();
    let sections = column(&db, "SELECT name FROM thread_sections");
    let projects = column(&db, "SELECT name FROM projects");
    assert_eq!((sections, projects), (vec![json!("Later")], vec![json!("demo")]));
    let list = |query: Value| {
        let query: ThreadListQuery = serde_json::from_value(query).unwrap();
        let rows = list_thread_rows(&db, &query).unwrap();
        serde_json::to_value(rows).unwrap().as_array().unwrap().clone()
    };
    let threads = list(json!({}));
    let listed = |id: &str| threads.iter().find(|thread| thread["id"] == id).unwrap().clone();
    assert_eq!(threads.len(), 3);
    assert_eq!(listed("thr_busy")["status"], "idle");
    assert_eq!(listed("thr_child")["parentThreadId"], "thr_parent");
    assert_eq!(listed("thr_parent")["sectionId"], "sec_later");
    assert_eq!(list(json!({ "archived": "true" })), Vec::<Value>::new());
    let said = column(
        &db,
        "SELECT COALESCE(data ->> '$.input[0].text', data ->> '$.item.text') FROM events
             WHERE thread_id = 'thr_parent' AND (type = 'client/turn/requested'
               OR (type = 'item/completed' AND item_kind = 'agentMessage')) ORDER BY sequence",
    );
    assert_eq!(said, [json!("question 1"), json!("answer 1")]);
    let moved = "SELECT t.provider_thread_id, model, p.status, host_id
      FROM threads t, pending_interactions p, environments WHERE model NOT NULL";
    let kept: Option<Value> = db.get(moved, []).unwrap();
    let kept: Vec<Value> = kept.unwrap().as_object().unwrap().values().cloned().collect();
    assert_eq!(kept, [json!("session-1"), json!("gpt-test"), json!("interrupted"), json!(host_id)]);
}

/// With `BB_IMPORT_DUMP=<dir>`, seeds `<dir>/source`, imports it into
/// `<dir>/rust-data` and writes every table to `<dir>/rust.json`.
#[tokio::test]
async fn dumps_an_import_for_comparison() {
    let Ok(dir) = std::env::var("BB_IMPORT_DUMP") else { return };
    let dir = Path::new(&dir);
    let source = dir.join("source");
    std::fs::create_dir_all(&source).unwrap();
    seed_original(&source.join("bb.db"));
    seed_extras(&source);
    let data_dir = dir.join("rust-data");
    let mut summaries = Map::new();
    for (name, choice) in [("all", ThreadChoice::All), ("active", ThreadChoice::Active)] {
        let mut summary =
            serde_json::to_value(run(&source, &data_dir, choice, false).await).unwrap();
        summary["elapsedMs"] = json!(0);
        summaries.insert(name.to_owned(), summary);
    }
    let dry = run(&source, &data_dir, ThreadChoice::None, true).await;
    summaries.insert("dry".to_owned(), serde_json::to_value(dry).unwrap());
    let db = Db::open(&data_dir.join("bb.db"), None).unwrap();
    let tables = column(&db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    let mut dump = Map::new();
    for table in tables.iter().filter_map(Value::as_str) {
        let rows = db.rows(&format!("SELECT * FROM \"{table}\""), []).unwrap();
        dump.insert(table.to_owned(), Value::Array(rows.into_iter().map(Value::Object).collect()));
    }
    let out = json!({ "summaries": summaries, "tables": dump });
    std::fs::write(dir.join("rust.json"), serde_json::to_string_pretty(&out).unwrap()).unwrap();
}

#[tokio::test]
async fn refuses_to_import_under_a_running_server() {
    let temp = tempfile::Builder::new().prefix("bb-original-").tempdir().unwrap();
    let from = temp.path();
    let data_dir = from.join("imported");
    seed_original(&from.join("bb.db"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let body = json!({ "dataDir": data_dir.display().to_string() }).to_string();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0; 4096];
            let _ = socket.read(&mut buffer).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let mut env = env_for(&data_dir);
    env.insert("BB_SERVER_PORT".to_owned(), port.to_string());
    let options = ImportLegacyOptions {
        from: from.display().to_string(),
        threads: ThreadChoice::All,
        dry_run: false,
        env: Some(env),
    };
    fn spawnable<T: Send + 'static>(future: T) -> T {
        future
    }
    let error = spawnable(import_legacy(options)).await.unwrap_err().to_string();
    let expected = format!(
        "A bb server is running on {}. Stop it, run the import, then start it again.",
        data_dir.display()
    );
    assert_eq!(error, expected);
    assert!(!data_dir.join("bb.db").exists());
}

#[tokio::test]
async fn summarises_an_import_in_lines() {
    let temp = tempfile::Builder::new().prefix("bb-original-").tempdir().unwrap();
    let from = temp.path();
    let data_dir = from.join("imported");
    seed_original(&from.join("bb.db"));
    let summary = run(from, &data_dir, ThreadChoice::None, false).await;
    let lines = import_summary_lines(&summary);
    let head = format!("Imported {} into {} in ", from.display(), data_dir.display());
    assert!(lines[0].starts_with(&head) && lines[0].ends_with("s (skipped = present):"));
    assert!(lines.contains(&"  events: 0 imported, 0 skipped, 0 pruned".to_owned()));
    assert!(lines.contains(&"  hosts: 1 imported, 0 skipped".to_owned()));
    assert!(lines.last().unwrap().starts_with("Not imported: plugin data (tasks,"));
    let missing = ImportLegacyOptions {
        from: from.join("nowhere").display().to_string(),
        threads: ThreadChoice::All,
        dry_run: true,
        env: None,
    };
    assert!(import_legacy(missing).await.is_err());
}
