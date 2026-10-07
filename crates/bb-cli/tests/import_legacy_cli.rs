mod support;

use std::path::Path;
use std::process::Command;

use rusqlite::Connection;
use serde_json::Value;
use support::{fail, ok};

const LEGACY_SQL: &str = "
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
INSERT INTO environments (id, project_id, host_id, created_at, updated_at)
  VALUES ('env_demo', 'proj_demo', 'host_old', 1, 1);
INSERT INTO threads (id, project_id, environment_id, provider_id, title, status,
  created_at, updated_at) VALUES ('thr_live', 'proj_demo', 'env_demo', 'codex',
  'Live', 'idle', 1, 1);
INSERT INTO threads (id, project_id, environment_id, provider_id, title, status,
  archived_at, created_at, updated_at) VALUES ('thr_old', 'proj_demo', 'env_demo',
  'codex', 'Old', 'idle', 5, 1, 1);";

fn legacy_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    Connection::open(dir.path().join("bb.db")).unwrap().execute_batch(LEGACY_SQL).unwrap();
    dir
}

fn bb(args: &[&str], data_dir: &Path) -> (i32, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_bb"))
        .args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", data_dir)
        .env("BB_DATA_DIR", data_dir.join("data"))
        .env("BB_SERVER_PORT", "0")
        .env("BB_SERVER_URL", "http://127.0.0.1:9")
        .output()
        .unwrap();
    let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
    (output.status.code().unwrap_or(-1), text(output.stdout), text(output.stderr))
}

#[test]
fn import_legacy_needs_from_and_a_known_threads_choice() {
    let error = fail("http://127.0.0.1:9", None, &["import-legacy"]);
    assert_eq!(error.message, "Pass --from <old data directory>.");
    assert_eq!(error.code, "invalid_value");
    let error =
        fail("http://127.0.0.1:9", None, &["import-legacy", "--from", "/x", "--threads", "x"]);
    assert_eq!(error.code, "invalid_value");
}

#[test]
fn import_legacy_dry_run_counts_each_choice() {
    let legacy = legacy_dir();
    let from = legacy.path().to_str().unwrap();
    let json =
        ok("http://127.0.0.1:9", None, &["import-legacy", "--from", from, "--dry-run", "--json"]);
    let summary: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(summary["dryRun"], true);
    assert_eq!(summary["from"], from);
    assert_eq!(summary["threads"], "active");
    assert_eq!(summary["choices"]["active"]["threads"], 1);
    assert_eq!(summary["choices"]["all"]["threads"], 2);
    let text = ok("http://127.0.0.1:9", None, &["import-legacy", "--from", from, "--dry-run"]);
    let first = format!("Dry run of {from}: nothing written. By --threads choice:");
    assert_eq!(text.lines().next(), Some(first.as_str()));
}

#[test]
fn import_legacy_writes_into_the_configured_data_directory() {
    let legacy = legacy_dir();
    let home = tempfile::tempdir().unwrap();
    let from = legacy.path().to_str().unwrap();
    let (code, out, err) = bb(&["import-legacy", "--from", from, "--threads", "all"], home.path());
    assert_eq!(code, 0, "{err}");
    let data = home.path().join("data");
    let first = format!("Imported {from} into {} in ", data.display());
    assert!(out.starts_with(&first), "{out}");
    let db = Connection::open(data.join("bb.db")).unwrap();
    let sql = "SELECT name FROM projects WHERE id = 'proj_demo'";
    let name: String = db.query_row(sql, [], |r| r.get(0)).unwrap();
    assert_eq!(name, "demo", "{out}");
    assert!(out.contains("\n  projects: 1 imported, 0 skipped\n"), "{out}");
    let (code, _, err) = bb(&["import-legacy", "--from", "/nonexistent/old"], home.path());
    assert_eq!(code, 1);
    assert!(err.starts_with("Error: unable to open database file"), "{err}");
}
