//! `bb import-legacy`: copies an original install's database into a data directory.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags, named_params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::config::{
    ConfigError, ServerConfig, ServerEnv, data_paths, load_config, loopback_url, process_env,
};
use crate::db::{Db, DbError, OpenError};

type Row = IndexMap<String, SqlValue>;
pub type Numbers = IndexMap<String, i64>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadChoice {
    Active,
    All,
    None,
}

#[derive(Clone, Debug)]
pub struct ImportLegacyOptions {
    pub from: String,
    pub threads: ThreadChoice,
    pub dry_run: bool,
    /// The server environment; the process environment when absent.
    pub env: Option<ServerEnv>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLegacySummary {
    pub dry_run: bool,
    pub from: String,
    pub threads: ThreadChoice,
    pub choices: IndexMap<String, Numbers>,
    pub counts: IndexMap<String, Numbers>,
    pub data_dir: Option<String>,
    pub not_imported: String,
    pub elapsed_ms: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportLegacyError {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Open(#[from] OpenError),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("A bb server is running on {0}. Stop it, run the import, then start it again.")]
    ServerRunning(String),
}

const SERVER_PROBE_MS: u64 = 2_000;
const NOT_IMPORTED: &str = "plugin data (tasks, account pool accounts, secrets), automations, \
    attachments, terminals, queued messages, right-panel tabs, provider logins (Codex and Claude \
    Code keep their own), machine credentials (other machines stay offline until `bb machine \
    reconnect <name>`)";
const GENERAL_KEYS: &[&str] = &[
    "showKeyboardHints",
    "steerActiveThreadOnEnter",
    "confirmThreadArchive",
    "showDiagnosticEvents",
    "providerOrder",
    "defaultProviderId",
    "providerCompletedTurnDisplay",
    "streamerMode",
    "allowFastServiceTier",
    "telemetryEnabled",
    "managedBranchPrefix",
    "machineServerUrl",
    "machineGitCredentialsEnabled",
    "defaultMachineAccess",
];
const ACTIVE: &str = "deleted_at IS NULL AND id IN (
    WITH RECURSIVE
      live (id) AS (SELECT id FROM threads
        WHERE archived_at IS NULL AND deleted_at IS NULL),
      up (id) AS (SELECT id FROM live UNION SELECT t.parent_thread_id
        FROM threads t JOIN up ON t.id = up.id),
      down (id) AS (SELECT id FROM live UNION SELECT t.id
        FROM threads t JOIN down ON t.parent_thread_id = down.id)
    SELECT id FROM up UNION SELECT id FROM down)";
const CHOSEN: [(ThreadChoice, &str, &str); 3] = [
    (ThreadChoice::Active, "active", ACTIVE),
    (ThreadChoice::All, "all", "deleted_at IS NULL"),
    (ThreadChoice::None, "none", "0"),
];
const HOSTS: &str = "SELECT id, name, type, max_permission_mode, destroyed_at,
  created_at, updated_at, IIF(destroyed_at IS NULL, 'active', 'destroyed')
  AS phase FROM hosts ORDER BY created_at, id";
const PROJECTS: &str = "SELECT *, (SELECT json_object('providerId', provider_id,
    'model', model, 'serviceTier', service_tier, 'reasoningLevel',
    reasoning_level, 'permissionMode', permission_mode)
  FROM project_execution_defaults WHERE project_id = projects.id)
  AS execution_defaults FROM projects";
const ENVIRONMENTS: &str = "SELECT *, NULL AS environment_provider_selection,
  IIF(status = 'destroyed', provider_owns_path, 0) AS provider_owns_path,
  NULL AS retire_at, NULL AS teardown_status, 0 AS teardown_attempt,
  NULL AS teardown_message FROM environments
  WHERE id IN (SELECT environment_id FROM threads WHERE ";
const THREADS: &str = "SELECT *, IIF(status = 'error', 'error', 'idle') AS status,
  NULL AS startup_context, IIF(origin_kind = 'fork', 'fork', NULL)
  AS origin_kind FROM threads WHERE ";
const THREAD_LINKS: [(&str, &str); 5] = [
    ("environment_id", "environments"),
    ("section_id", "thread_sections"),
    ("parent_thread_id", "threads"),
    ("source_thread_id", "threads"),
    ("lifecycle_owner_thread_id", "threads"),
];
const SIDEBAR_PREFERENCES: &str = "SELECT * FROM plugin_kv
  WHERE plugin_id = 'thread-list' AND key LIKE 'preference:%'";
const RESTORE_SESSION: &str = "UPDATE threads SET
  provider_thread_id = (SELECT provider_thread_id FROM events
    WHERE thread_id = @id AND type = 'thread/identity' AND sequence > COALESCE(
      (SELECT MAX(sequence) FROM events WHERE thread_id = @id
        AND type = 'system/operation' AND data ->> '$.status' = 'completed'
        AND data ->> '$.operation' = 'context_clear'), 0)
    ORDER BY sequence DESC LIMIT 1),
  (model, reasoning_level, permission_mode, service_tier) = (
    SELECT data ->> '$.execution.model', data ->> '$.execution.reasoningLevel',
      data ->> '$.execution.permissionMode', data ->> '$.execution.serviceTier'
    FROM events WHERE thread_id = @id AND type = 'client/turn/requested'
    ORDER BY sequence DESC LIMIT 1)
  WHERE id = @id";
const EMPTY_THREAD: &str = "SELECT 1 FROM threads WHERE id = ?
  AND NOT EXISTS (SELECT 1 FROM events WHERE thread_id = threads.id)";
const SETTLED: &str = "status NOT IN ('pending', 'resolving')";
const DELTA_SUFFIXES: [&str; 4] = ["/delta", "/textDelta", "/summaryTextDelta", "/outputDelta"];

fn settings_sql() -> String {
    let general = GENERAL_KEYS.join("', '");
    format!(
        "SELECT key, value, updated_at FROM app_settings_values
    WHERE key IN ('keybindingOverrides', 'disabledProviderIds')
  UNION ALL SELECT 'general', json_group_object(key, json(value)),
    MAX(updated_at) FROM app_settings_values
    WHERE key IN ('{general}') HAVING COUNT(*) > 0
  UNION ALL SELECT 'appearance', json_object('themeId', theme_id,
    'faviconColor', favicon_color), updated_at
    FROM app_theme WHERE id = 'current'"
    )
}

fn thread_content() -> [(&'static str, String); 3] {
    [
        ("prompt_history_entries", String::new()),
        ("thread_search_segments", String::new()),
        (
            "pending_interactions",
            format!(
                ", IIF({SETTLED}, status, 'interrupted') AS status,
    IIF({SETTLED}, status_reason, 'thread-stopped') AS status_reason,
    COALESCE(resolved_at, updated_at) AS resolved_at"
            ),
        ),
    ]
}

fn is_delta_type(kind: &str) -> bool {
    DELTA_SUFFIXES.iter().any(|suffix| kind.ends_with(suffix))
}

fn js_string(value: &SqlValue) -> String {
    match value {
        SqlValue::Null => "null".to_owned(),
        SqlValue::Integer(number) => number.to_string(),
        SqlValue::Real(number) => number.to_string(),
        SqlValue::Text(text) => text.clone(),
        SqlValue::Blob(bytes) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

fn rows(legacy: &Connection, sql: &str, params: &[SqlValue]) -> rusqlite::Result<Vec<Row>> {
    let mut statement = legacy.prepare(sql)?;
    let names: Vec<String> = statement.column_names().into_iter().map(str::to_owned).collect();
    let mut found = statement.query(params_from_iter(params))?;
    let mut out = Vec::new();
    while let Some(row) = found.next()? {
        let mut object = Row::with_capacity(names.len());
        for (index, name) in names.iter().enumerate() {
            object.insert(name.clone(), row.get::<_, SqlValue>(index)?);
        }
        out.push(object);
    }
    Ok(out)
}

fn select(legacy: &Connection, among: &str) -> rusqlite::Result<Vec<Row>> {
    rows(legacy, &format!("SELECT id FROM threads WHERE {among}"), &[])
}

fn id_of(row: &Row) -> SqlValue {
    row.get("id").cloned().unwrap_or(SqlValue::Null)
}

fn event_count(legacy: &Connection, threads: &[Row]) -> rusqlite::Result<i64> {
    let sql = "SELECT COUNT(*) FROM events WHERE thread_id = ?";
    threads.iter().try_fold(0, |sum, thread| {
        let stored: i64 = legacy.query_row(sql, [id_of(thread)], |row| row.get(0))?;
        Ok(sum + stored)
    })
}

async fn refuse_running_server(config: &ServerConfig) -> Result<(), ImportLegacyError> {
    let url = format!("{}/api/v1/system/config", loopback_url(config));
    let timeout = Duration::from_millis(SERVER_PROBE_MS);
    let answer = async {
        let client = reqwest::Client::builder().timeout(timeout).build().ok()?;
        client.get(url).send().await.ok()?.json::<serde_json::Value>().await.ok()
    }
    .await;
    let running = answer.as_ref().and_then(|body| body.get("dataDir")?.as_str());
    let data_dir = config.data_dir.display().to_string();
    if running == Some(data_dir.as_str()) {
        return Err(ImportLegacyError::ServerRunning(data_dir));
    }
    Ok(())
}

struct TableWriter<'a> {
    db: &'a Db,
    inserts: HashMap<String, (String, Vec<String>)>,
    counts: &'a mut IndexMap<String, Numbers>,
}

impl TableWriter<'_> {
    fn add(&mut self, table: &str, row: &Row) -> Result<(), DbError> {
        if !self.inserts.contains_key(table) {
            let columns: Vec<NameRow> =
                self.db.all("SELECT name FROM pragma_table_info(?)", [table])?;
            let names: Vec<String> = columns
                .into_iter()
                .map(|column| column.name)
                .filter(|name| row.contains_key(name))
                .collect();
            let values = vec!["?"; names.len()].join(", ");
            let sql =
                format!("INSERT OR IGNORE INTO {table} ({}) VALUES ({values})", names.join(", "));
            self.inserts.insert(table.to_owned(), (sql, names));
        }
        let Some((sql, names)) = self.inserts.get(table) else { return Ok(()) };
        let bound = names.iter().map(|name| row.get(name).cloned().unwrap_or(SqlValue::Null));
        let changed = self.db.run(sql, params_from_iter(bound))?;
        let tally = self.counts.entry(table.to_owned()).or_insert_with(|| {
            Numbers::from([("imported".to_owned(), 0), ("skipped".to_owned(), 0)])
        });
        let outcome = if changed == 1 { "imported" } else { "skipped" };
        *tally.entry(outcome.to_owned()).or_insert(0) += 1;
        Ok(())
    }
}

#[derive(Deserialize)]
struct NameRow {
    name: String,
}

fn import_catalog(
    legacy: &Connection,
    db: &Db,
    writer: &mut TableWriter<'_>,
    chosen: &str,
    host_id: &dyn Fn(SqlValue) -> SqlValue,
) -> Result<(), ImportLegacyError> {
    let on_host = |mut row: Row| {
        let id = row.get("host_id").cloned().unwrap_or(SqlValue::Null);
        row.insert("host_id".to_owned(), host_id(id));
        row
    };
    let mut copy =
        |table: &str, sql: &str, edit: &dyn Fn(Row) -> Row| -> Result<(), ImportLegacyError> {
            for row in rows(legacy, sql, &[])? {
                writer.add(table, &edit(row))?;
            }
            Ok(())
        };
    let all = |table: &str| format!("SELECT * FROM {table}");
    db.exec_batch("PRAGMA defer_foreign_keys = ON")?;
    copy("threads", &format!("{THREADS}{chosen}"), &on_host)?;
    copy("environments", &format!("{ENVIRONMENTS}{chosen})"), &on_host)?;
    copy("thread_sections", &all("thread_sections"), &on_host)?;
    copy("project_sources", &all("project_sources"), &on_host)?;
    copy("projects", PROJECTS, &on_host)?;
    copy("hosts", HOSTS, &|mut host: Row| {
        let id = id_of(&host);
        host.insert("id".to_owned(), host_id(id));
        host
    })?;
    for (column, table) in THREAD_LINKS {
        db.run(
            &format!(
                "UPDATE threads SET {column} = NULL
      WHERE {column} NOT IN (SELECT id FROM {table})"
            ),
            [],
        )?;
    }
    copy("settings", &settings_sql(), &on_host)?;
    copy("ui_preferences", &all("ui_preferences"), &on_host)?;
    copy("plugin_kv", SIDEBAR_PREFERENCES, &on_host)?;
    Ok(())
}

fn import_thread(
    legacy: &Connection,
    db: &Db,
    writer: &mut TableWriter<'_>,
    id: &SqlValue,
) -> Result<i64, ImportLegacyError> {
    let settled = "SELECT item_id FROM events WHERE thread_id = ? AND type = 'item/completed'";
    let completed: HashSet<String> = rows(legacy, settled, std::slice::from_ref(id))?
        .iter()
        .map(|event| format!("{:?}", event.get("item_id").unwrap_or(&SqlValue::Null)))
        .collect();
    let mut kept = HashSet::new();
    let mut pruned = 0;
    let mut statement =
        legacy.prepare("SELECT * FROM events WHERE thread_id = ? ORDER BY sequence")?;
    let names: Vec<String> = statement.column_names().into_iter().map(str::to_owned).collect();
    let mut stored = statement.query([id])?;
    while let Some(found) = stored.next()? {
        let mut event = Row::with_capacity(names.len());
        for (index, name) in names.iter().enumerate() {
            event.insert(name.clone(), found.get::<_, SqlValue>(index)?);
        }
        let kind = event.get("type").map(js_string).unwrap_or_else(|| "undefined".to_owned());
        let item = event.get("item_id").cloned().unwrap_or(SqlValue::Null);
        let settled_delta = is_delta_type(&kind) && completed.contains(&format!("{item:?}"));
        if settled_delta && !kept.insert(format!("{}|{kind}", js_string(&item))) {
            pruned += 1;
        } else {
            writer.add("events", &event)?;
        }
    }
    db.run(RESTORE_SESSION, named_params! { "@id": id })?;
    for (table, changed) in thread_content() {
        let sql = format!("SELECT *{changed} FROM {table} WHERE thread_id = ?");
        for row in rows(legacy, &sql, std::slice::from_ref(id))? {
            writer.add(table, &row)?;
        }
    }
    Ok(pruned)
}

/// Copies the original install in `options.from` into the configured data
/// directory, or with `dry_run` only counts what each `--threads` choice holds.
pub async fn import_legacy(
    options: ImportLegacyOptions,
) -> Result<ImportLegacySummary, ImportLegacyError> {
    let started_at = Instant::now();
    let ImportLegacyOptions { from, threads, dry_run, env } = options;
    let mut choices = IndexMap::new();
    let mut counts = IndexMap::new();
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let legacy = Connection::open_with_flags(Path::new(&from).join("bb.db"), flags)?;
    legacy.pragma_update(None, "query_only", "ON")?;
    let mut data_dir = None;
    if dry_run {
        for (_, choice, among) in CHOSEN {
            let found = select(&legacy, among)?;
            let events = event_count(&legacy, &found)?;
            let numbers =
                [("threads".to_owned(), found.len() as i64), ("events".to_owned(), events)];
            choices.insert(choice.to_owned(), Numbers::from(numbers));
        }
    } else {
        let config = load_config(&env.unwrap_or_else(process_env))?;
        refuse_running_server(&config).await?;
        let paths = data_paths(&config.data_dir);
        let host_file = Path::new(&from).join("host-id");
        let hosts = rows(&legacy, HOSTS, &[])?;
        let local = if host_file.exists() {
            Some(SqlValue::Text(std::fs::read_to_string(&host_file)?.trim().to_owned()))
        } else {
            hosts.first().map(id_of)
        };
        let local_host = SqlValue::Text(config.host_id.clone());
        let host_id =
            |id: SqlValue| if local.as_ref() == Some(&id) { local_host.clone() } else { id };
        let db = Db::open(&paths.database, None)?;
        let mut writer = TableWriter { db: &db, inserts: HashMap::new(), counts: &mut counts };
        let chosen = CHOSEN.iter().find(|(choice, ..)| *choice == threads).map_or("0", |c| c.2);
        db.transaction(|| import_catalog(&legacy, &db, &mut writer, chosen, &host_id))?;
        let events = Numbers::from([
            ("imported".to_owned(), 0),
            ("skipped".to_owned(), 0),
            ("pruned".to_owned(), 0),
        ]);
        writer.counts.insert("events".to_owned(), events);
        for thread in select(&legacy, chosen)? {
            let id = id_of(&thread);
            let empty: Option<i64> = db.scalar(EMPTY_THREAD, [&id])?;
            if empty.is_none() {
                let skipped = event_count(&legacy, std::slice::from_ref(&thread))?;
                *writer.counts["events"].entry("skipped".to_owned()).or_insert(0) += skipped;
            } else {
                let pruned = db.transaction(|| import_thread(&legacy, &db, &mut writer, &id))?;
                *writer.counts["events"].entry("pruned".to_owned()).or_insert(0) += pruned;
            }
        }
        data_dir = Some(config.data_dir.display().to_string());
    }
    Ok(ImportLegacySummary {
        dry_run,
        from,
        threads,
        choices,
        counts,
        data_dir,
        not_imported: NOT_IMPORTED.to_owned(),
        elapsed_ms: started_at.elapsed().as_millis() as i64,
    })
}

pub fn import_summary_lines(summary: &ImportLegacySummary) -> Vec<String> {
    let seconds = format!("{:.1}", summary.elapsed_ms as f64 / 1_000.0);
    let line = |(kind, numbers): (&String, &Numbers)| {
        let parts: Vec<String> = numbers.iter().map(|(unit, n)| format!("{n} {unit}")).collect();
        format!("  {kind}: {}", parts.join(", "))
    };
    let mut merged: IndexMap<&String, &Numbers> = summary.choices.iter().collect();
    merged.extend(summary.counts.iter());
    let first = if summary.dry_run {
        format!("Dry run of {}: nothing written. By --threads choice:", summary.from)
    } else {
        let data_dir = summary.data_dir.as_deref().unwrap_or("null");
        format!("Imported {} into {data_dir} in {seconds}s (skipped = present):", summary.from)
    };
    let mut lines = vec![first];
    lines.extend(merged.into_iter().map(line));
    lines.push(format!("Not imported: {}.", summary.not_imported));
    lines
}
