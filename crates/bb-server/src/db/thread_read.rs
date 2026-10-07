use rusqlite::types::Value as SqlValue;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::threads::ThreadRow;
use super::{Db, DbResult};
use crate::domain::environment::EnvironmentStatus;
use crate::domain::thread::ThreadOriginKind;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListRow {
    #[serde(flatten)]
    pub thread: ThreadRow,
    pub environment_branch_name: Option<String>,
    pub environment_host_id: Option<String>,
    pub environment_is_worktree: Option<i64>,
    pub environment_name: Option<String>,
    pub environment_path: Option<String>,
    pub environment_provider_id: Option<String>,
    pub environment_status: Option<EnvironmentStatus>,
    pub has_pending_interaction: i64,
}

impl std::ops::Deref for ThreadListRow {
    type Target = ThreadRow;
    fn deref(&self) -> &ThreadRow {
        &self.thread
    }
}

/// A `"true"` / `"false"` query-string flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueryFlag {
    True,
    False,
}

/// `ThreadListQuery` from the server contract.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<QueryFlag>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsectioned: Option<QueryFlag>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_parent: Option<QueryFlag>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_kind: Option<ThreadOriginKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_hidden: Option<QueryFlag>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionRow {
    pub id: String,
    pub project_id: String,
    pub title: Option<String>,
    pub title_fallback: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadChildSummary {
    pub non_deleted_child_count: i64,
    pub unarchived_descendant_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCount {
    pub thread_id: String,
    pub queued: i64,
    pub failed: i64,
}

/// `input` holds `PromptInput` JSON values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptHistoryEntry {
    pub id: String,
    pub created_at: i64,
    pub input: Vec<Value>,
}

pub enum PromptHistoryScope<'a> {
    Project(&'a str),
    Thread(&'a str),
}

const THREAD_LIST_SELECT: &str = "SELECT threads.*,
    e.branch_name AS environment_branch_name,
    e.host_id AS environment_host_id,
    e.is_worktree AS environment_is_worktree,
    e.name AS environment_name, e.path AS environment_path,
    e.environment_provider_id AS environment_provider_id,
    e.status AS environment_status,
    EXISTS (SELECT 1 FROM pending_interactions AS p
      WHERE p.thread_id = threads.id AND p.status = 'pending')
      AS has_pending_interaction
  FROM threads LEFT JOIN environments AS e ON e.id = threads.environment_id";
const ACTIVE_THREAD_ORDER: &str =
    "threads.project_id, CASE WHEN threads.pinned_at IS NOT NULL THEN 0
    ELSE 1 END, CASE WHEN threads.pinned_at IS NOT NULL THEN threads.pin_sort_key END,
  CASE WHEN threads.pinned_at IS NOT NULL THEN threads.id END, threads.created_at DESC,
  threads.id DESC";
const IN_LIST: &str = "IN (SELECT value FROM json_each(?))";

pub fn find_thread_list_row(db: &Db, thread_id: &str) -> DbResult<Option<ThreadListRow>> {
    let sql = format!("{THREAD_LIST_SELECT} WHERE threads.id = ?");
    db.get(&sql, [thread_id])
}

fn thread_filter(
    equal: &[(&str, Option<SqlValue>)],
    nullness: &[(&str, Option<QueryFlag>)],
    hidden: Option<QueryFlag>,
) -> (String, Vec<SqlValue>) {
    let mut clauses = vec!["threads.deleted_at IS NULL".to_owned()];
    let mut params = Vec::new();
    for (column, value) in equal {
        let Some(value) = value else { continue };
        clauses.push(format!("{column} = ?"));
        params.push(value.clone());
    }
    for (column, wanted) in nullness {
        let Some(wanted) = wanted else { continue };
        let test = if *wanted == QueryFlag::True { "NOT NULL" } else { "NULL" };
        clauses.push(format!("{column} IS {test}"));
    }
    if hidden != Some(QueryFlag::True) {
        clauses.push("threads.visibility = 'visible'".to_owned());
    }
    (clauses.join(" AND "), params)
}

fn text(value: &Option<String>) -> Option<SqlValue> {
    value.clone().map(SqlValue::Text)
}

pub fn list_thread_rows(db: &Db, query: &ThreadListQuery) -> DbResult<Vec<ThreadListRow>> {
    let origin_kind = query.origin_kind.map(|kind| SqlValue::Text(kind.as_str().to_owned()));
    let unsectioned = (query.unsectioned == Some(QueryFlag::True)).then_some(QueryFlag::False);
    let (filter, mut params) = thread_filter(
        &[
            ("threads.project_id", text(&query.project_id)),
            ("threads.environment_id", text(&query.environment_id)),
            ("e.host_id", text(&query.host_id)),
            ("threads.parent_thread_id", text(&query.parent_thread_id)),
            ("threads.section_id", text(&query.section_id)),
            ("threads.origin_kind", origin_kind),
            ("threads.origin_plugin_id", text(&query.origin_plugin_id)),
        ],
        &[
            ("threads.archived_at", query.archived),
            ("threads.parent_thread_id", query.has_parent),
            ("threads.section_id", unsectioned),
        ],
        query.include_hidden,
    );
    let order = if query.archived == Some(QueryFlag::True) {
        "threads.archived_at DESC, threads.id DESC"
    } else {
        ACTIVE_THREAD_ORDER
    };
    let number = |value: &Option<String>, fallback: i64| {
        value.as_deref().and_then(|value| value.parse::<i64>().ok()).unwrap_or(fallback)
    };
    params.push(SqlValue::Integer(number(&query.limit, -1)));
    params.push(SqlValue::Integer(number(&query.offset, 0)));
    let sql = format!(
        "{THREAD_LIST_SELECT} WHERE {filter}
     ORDER BY {order} LIMIT ? OFFSET ?"
    );
    db.all(&sql, rusqlite::params_from_iter(params))
}

fn id_list(thread_ids: &[String]) -> DbResult<String> {
    Ok(serde_json::to_string(thread_ids)?)
}

pub fn list_thread_rows_by_ids(db: &Db, thread_ids: &[String]) -> DbResult<Vec<ThreadListRow>> {
    let sql = format!(
        "{THREAD_LIST_SELECT}
     WHERE threads.id {IN_LIST} AND threads.deleted_at IS NULL"
    );
    db.all(&sql, [id_list(thread_ids)?])
}

pub fn list_sidebar_thread_rows(db: &Db) -> DbResult<Vec<ThreadListRow>> {
    let sql = format!(
        "{THREAD_LIST_SELECT}
     WHERE threads.deleted_at IS NULL AND threads.archived_at IS NULL
       AND threads.visibility = 'visible'
     ORDER BY {ACTIVE_THREAD_ORDER}"
    );
    db.all(&sql, [])
}

pub fn thread_child_summary(db: &Db, thread_id: &str) -> DbResult<ThreadChildSummary> {
    #[derive(Deserialize)]
    struct Counts {
        children: i64,
        descendants: i64,
    }
    let row: Option<Counts> = db.get(
        "WITH RECURSIVE tree (id, archived_at) AS (
       SELECT id, archived_at FROM threads
       WHERE deleted_at IS NULL AND (parent_thread_id = :threadId
         OR lifecycle_owner_thread_id = :threadId)
       UNION
       SELECT threads.id, threads.archived_at
       FROM threads JOIN tree ON threads.parent_thread_id = tree.id
         OR threads.lifecycle_owner_thread_id = tree.id
       WHERE threads.deleted_at IS NULL)
     SELECT
       (SELECT COUNT(*) FROM threads WHERE parent_thread_id = :threadId
         AND deleted_at IS NULL) AS children,
       (SELECT COUNT(*) FROM tree WHERE id <> :threadId
         AND archived_at IS NULL) AS descendants",
        rusqlite::named_params! { ":threadId": thread_id },
    )?;
    Ok(ThreadChildSummary {
        non_deleted_child_count: row.as_ref().map_or(0, |row| row.children),
        unarchived_descendant_count: row.as_ref().map_or(0, |row| row.descendants),
    })
}

pub fn list_thread_mention_rows(db: &Db, thread_ids: &[String]) -> DbResult<Vec<MentionRow>> {
    let sql = format!(
        "SELECT threads.id, threads.project_id, threads.title,
       threads.title_fallback
     FROM threads JOIN projects ON projects.id = threads.project_id
     WHERE threads.id {IN_LIST} AND threads.deleted_at IS NULL
       AND projects.deleted_at IS NULL"
    );
    db.all(&sql, [id_list(thread_ids)?])
}

pub fn list_queue_counts(db: &Db, thread_ids: &[String]) -> DbResult<Vec<QueueCount>> {
    let sql = format!(
        "SELECT thread_id, COUNT(id) AS queued, COUNT(failure_reason) AS failed
     FROM queued_thread_messages
     WHERE thread_id {IN_LIST} GROUP BY thread_id"
    );
    db.all(&sql, [id_list(thread_ids)?])
}

pub fn list_prompt_history_entries(
    db: &Db,
    scope: PromptHistoryScope<'_>,
    limit: i64,
) -> DbResult<Vec<PromptHistoryEntry>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HistoryRow {
        id: String,
        created_at: i64,
        input: String,
    }
    let (filter, id) = match scope {
        PromptHistoryScope::Project(project_id) => (
            "h.project_id = ? AND h.scope = 'project' AND (SELECT deleted_at
             FROM threads WHERE threads.id = h.thread_id) IS NULL",
            project_id,
        ),
        PromptHistoryScope::Thread(thread_id) => {
            ("h.thread_id = ? AND h.scope = 'thread'", thread_id)
        }
    };
    let sql = format!(
        "SELECT h.id, h.created_at, h.input FROM prompt_history_entries AS h
     WHERE {filter}
     ORDER BY h.created_at DESC, h.request_sequence DESC, h.id DESC LIMIT ?"
    );
    let rows: Vec<HistoryRow> = db.all(&sql, rusqlite::params![id, limit])?;
    let mut entries = Vec::new();
    for row in rows {
        let input: Value = serde_json::from_str(&row.input)?;
        let Value::Array(input) = input else { continue };
        if input.is_empty() || !input.iter().all(Value::is_object) {
            continue;
        }
        entries.push(PromptHistoryEntry { id: row.id, created_at: row.created_at, input });
    }
    Ok(entries)
}
