#![allow(clippy::result_large_err)]

use std::collections::HashSet;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::events::upsert_search_segment;
use super::{Db, DbResult, OnConflict, RowValues, insert_row, new_id, update_row};
use crate::domain::thread::{
    Thread, ThreadLifecycleEvaluation, ThreadLifecycleEventType, ThreadLifecycleNoopReason,
    ThreadLifecycleRowState, ThreadStatus, ThreadVisibility, evaluate_thread_lifecycle_event,
};
use crate::error::{ApiError, ApiResult, conflict, thread_not_found};
use crate::row;

/// A `threads` row: the domain [`Thread`] plus the server-only columns.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    #[serde(flatten)]
    pub thread: Thread,
    pub provider_thread_id: Option<String>,
    pub active_turn_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_level: Option<String>,
    pub permission_mode: Option<String>,
    pub service_tier: Option<String>,
    pub model_override: Option<String>,
    pub reasoning_level_override: Option<String>,
    pub startup_context: Option<String>,
    pub pin_sort_key: Option<String>,
    pub storage_deleted_at: Option<i64>,
}

impl std::ops::Deref for ThreadRow {
    type Target = Thread;
    fn deref(&self) -> &Thread {
        &self.thread
    }
}

impl std::ops::DerefMut for ThreadRow {
    fn deref_mut(&mut self) -> &mut Thread {
        &mut self.thread
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewThread {
    pub project_id: String,
    pub provider_id: String,
    pub model: Option<String>,
    pub reasoning_level: Option<String>,
    pub permission_mode: Option<String>,
    pub service_tier: Option<String>,
    pub title: Option<String>,
    pub title_fallback: Option<String>,
    pub section_id: Option<String>,
    pub startup_context: Option<String>,
    pub parent_thread_id: Option<String>,
    pub lifecycle_owner_thread_id: Option<String>,
    pub origin_plugin_id: Option<String>,
    pub visibility: ThreadVisibility,
    pub pinned: bool,
}

/// Camel-case column values to write; every key but `id`, `projectId`, `status`,
/// `createdAt` and `updatedAt` may appear.
pub type ThreadPatch = RowValues;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleRefusal {
    Missing,
    CasConflict,
    IllegalTransition,
    Superseded,
}

impl From<ThreadLifecycleNoopReason> for LifecycleRefusal {
    fn from(reason: ThreadLifecycleNoopReason) -> Self {
        match reason {
            ThreadLifecycleNoopReason::IllegalTransition => LifecycleRefusal::IllegalTransition,
            ThreadLifecycleNoopReason::Superseded => LifecycleRefusal::Superseded,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum LifecycleOutcome {
    Applied { from: ThreadStatus, thread: Box<ThreadRow> },
    NotApplied { reason: LifecycleRefusal },
}

pub const MAX_THREAD_HIERARCHY_DEPTH: usize = 4;
const LIVE: &str = "deleted_at IS NULL";

pub fn get_thread(db: &Db, id: &str) -> DbResult<Option<ThreadRow>> {
    db.get("SELECT * FROM threads WHERE id = ?", [id])
}

pub fn require_thread(db: &Db, id: &str) -> ApiResult<ThreadRow> {
    match get_thread(db, id)? {
        Some(thread) if thread.deleted_at.is_none() => Ok(thread),
        _ => Err(thread_not_found()),
    }
}

pub fn next_pin_sort_key(db: &Db) -> ApiResult<String> {
    let first: Option<Option<String>> =
        db.scalar("SELECT MIN(pin_sort_key) AS key FROM threads WHERE pinned_at IS NOT NULL", [])?;
    super::order_keys::order_key_between(None, first.flatten().as_deref())
        .map_err(ApiError::internal)
}

fn sync_title_search(db: &Db, thread: &ThreadRow) -> DbResult<()> {
    upsert_search_segment(db, &thread.id, "title", "title", None, thread.title.as_deref())?;
    let fallback = thread.title_fallback.as_deref();
    let kind = "title_fallback";
    upsert_search_segment(db, &thread.id, kind, kind, None, fallback)
}

pub fn insert_thread(db: &Db, input: NewThread) -> ApiResult<ThreadRow> {
    let now = db.now();
    let id = new_id("thr");
    let pin_sort_key = if input.pinned { Some(next_pin_sort_key(db)?) } else { None };
    let values = row! {
        "projectId" => input.project_id,
        "providerId" => input.provider_id,
        "model" => input.model,
        "reasoningLevel" => input.reasoning_level,
        "permissionMode" => input.permission_mode,
        "serviceTier" => input.service_tier,
        "title" => input.title,
        "titleFallback" => input.title_fallback,
        "sectionId" => input.section_id,
        "startupContext" => input.startup_context,
        "parentThreadId" => input.parent_thread_id,
        "lifecycleOwnerThreadId" => input.lifecycle_owner_thread_id,
        "originPluginId" => input.origin_plugin_id,
        "visibility" => input.visibility.as_str(),
        "id" => id.as_str(),
        "status" => "pending",
        "pinnedAt" => input.pinned.then_some(now),
        "pinSortKey" => pin_sort_key,
        "lastReadAt" => now,
        "latestAttentionAt" => now,
        "createdAt" => now,
        "updatedAt" => now,
    };
    insert_row(db, "threads", &values, OnConflict::Fail)?;
    let thread =
        get_thread(db, &id)?.ok_or_else(|| ApiError::internal("Thread insert was lost"))?;
    sync_title_search(db, &thread)?;
    Ok(thread)
}

pub fn patch_thread(db: &Db, id: &str, patch: &ThreadPatch, touch: bool) -> ApiResult<ThreadRow> {
    if touch || !patch.is_empty() {
        update_row(db, "threads", id, patch, touch)?;
    }
    let thread = get_thread(db, id)?
        .ok_or_else(|| ApiError::internal(format!("Thread {id} does not exist")))?;
    if patch.get("title").is_some() {
        sync_title_search(db, &thread)?;
    }
    Ok(thread)
}

fn needs_attention(thread: &ThreadRow, to: ThreadStatus) -> bool {
    if to == ThreadStatus::Error {
        return true;
    }
    let finished = thread.status == ThreadStatus::Active && to == ThreadStatus::Idle;
    finished && thread.parent_thread_id.is_none()
}

/// The one compare-and-set writer of `threads.status`.
pub fn apply_lifecycle_event(
    db: &Db,
    id: &str,
    event: ThreadLifecycleEventType,
) -> DbResult<LifecycleOutcome> {
    let Some(thread) = get_thread(db, id)? else {
        return Ok(LifecycleOutcome::NotApplied { reason: LifecycleRefusal::Missing });
    };
    let state = ThreadLifecycleRowState {
        archived_at: thread.archived_at,
        deleted_at: thread.deleted_at,
        status: thread.status,
    };
    let to = match evaluate_thread_lifecycle_event(event, &state) {
        ThreadLifecycleEvaluation::To(to) => to,
        ThreadLifecycleEvaluation::Noop { noop, .. } => {
            return Ok(LifecycleOutcome::NotApplied { reason: noop.into() });
        }
    };
    let now = db.now();
    let settled = matches!(to, ThreadStatus::Idle | ThreadStatus::Error);
    let has_environment = thread.environment_id.as_deref().is_some_and(|id| !id.is_empty());
    let started = to == ThreadStatus::Active || (to == ThreadStatus::Idle && has_environment);
    let mut next = thread.clone();
    next.status = to;
    next.updated_at = now;
    if needs_attention(&thread, to) {
        next.latest_attention_at = now;
    }
    if settled {
        next.active_turn_id = None;
    }
    if started {
        next.startup_context = None;
    }
    let changes = db.run(
        "UPDATE threads
     SET status = ?, updated_at = ?, latest_attention_at = ?,
         active_turn_id = ?, startup_context = ?
     WHERE id = ? AND status = ?",
        params![
            next.status.as_str(),
            next.updated_at,
            next.latest_attention_at,
            next.active_turn_id,
            next.startup_context,
            id,
            thread.status.as_str(),
        ],
    )?;
    if changes == 0 {
        return Ok(LifecycleOutcome::NotApplied { reason: LifecycleRefusal::CasConflict });
    }
    Ok(LifecycleOutcome::Applied { from: thread.status, thread: Box::new(next) })
}

fn select(db: &Db, condition: &str, params: impl rusqlite::Params) -> DbResult<Vec<ThreadRow>> {
    db.all(&format!("SELECT * FROM threads WHERE {condition}"), params)
}

pub fn list_child_threads(db: &Db, parent_thread_id: &str) -> DbResult<Vec<ThreadRow>> {
    select(db, &format!("parent_thread_id = ? AND {LIVE}"), [parent_thread_id])
}

/// The thread, its lifecycle-owned threads and its live children, depth first with every
/// thread after its descendants.
pub fn list_archive_tree(db: &Db, root: &ThreadRow) -> DbResult<Vec<ThreadRow>> {
    fn visit(
        db: &Db,
        thread: &ThreadRow,
        seen: &mut HashSet<String>,
        ordered: &mut Vec<ThreadRow>,
    ) -> DbResult<()> {
        if !seen.insert(thread.id.clone()) {
            return Ok(());
        }
        for owned in select(db, "lifecycle_owner_thread_id = ?", [thread.id.as_str()])? {
            visit(db, &owned, seen, ordered)?;
        }
        for child in list_child_threads(db, &thread.id)? {
            visit(db, &child, seen, ordered)?;
        }
        ordered.push(thread.clone());
        Ok(())
    }
    let mut ordered = Vec::new();
    visit(db, root, &mut HashSet::new(), &mut ordered)?;
    Ok(ordered)
}

/// The thread's id followed by its ancestors' ids, nearest first.
pub fn ancestry(db: &Db, thread: &ThreadRow) -> DbResult<Vec<String>> {
    let mut ids: Vec<String> = Vec::new();
    let mut current = Some(thread.clone());
    while let Some(row) = current {
        if ids.contains(&row.id) {
            break;
        }
        ids.push(row.id.clone());
        current = match &row.parent_thread_id {
            Some(parent_id) => get_thread(db, parent_id)?,
            None => None,
        };
    }
    Ok(ids)
}

pub fn subtree_depth(db: &Db, thread: &ThreadRow) -> DbResult<usize> {
    let mut deepest = 0;
    for child in list_child_threads(db, &thread.id)? {
        deepest = deepest.max(subtree_depth(db, &child)?);
    }
    Ok(1 + deepest)
}

pub fn list_threads_on_host(
    db: &Db,
    host_id: &str,
    statuses: &[ThreadStatus],
) -> DbResult<Vec<ThreadRow>> {
    let marks = vec!["?"; statuses.len()].join(", ");
    let on_host = "(SELECT id FROM environments WHERE host_id = ?)";
    let condition = format!("environment_id IN {on_host} AND status IN ({marks})");
    let values = std::iter::once(host_id).chain(statuses.iter().map(|status| status.as_str()));
    select(db, &format!("{condition} AND {LIVE}"), rusqlite::params_from_iter(values))
}

pub fn list_starting_threads(db: &Db) -> DbResult<Vec<ThreadRow>> {
    select(db, &format!("status = 'starting' AND {LIVE}"), [])
}

pub fn list_tombstoned_threads(db: &Db) -> DbResult<Vec<ThreadRow>> {
    select(db, "deleted_at IS NOT NULL", [])
}

pub fn list_expired_archives(db: &Db, archived_before: i64) -> DbResult<Vec<ThreadRow>> {
    let terminals = "SELECT thread_id FROM terminal_sessions
    WHERE status <> 'exited' AND thread_id IS NOT NULL";
    let busy = format!("status IN ('starting', 'active') OR id IN ({terminals})");
    let condition = format!("archived_at <= ? AND ({busy}) AND {LIVE}");
    select(db, &condition, [archived_before])
}

pub fn delete_thread_row(db: &Db, id: &str) -> DbResult<()> {
    db.run("DELETE FROM threads WHERE id = ?", [id])?;
    Ok(())
}

pub fn reorder_pinned_thread(
    db: &Db,
    id: &str,
    previous_thread_id: Option<&str>,
    next_thread_id: Option<&str>,
) -> ApiResult<()> {
    let stale = || conflict("Pinned order changed");
    let key_of = |thread_id: Option<&str>| -> ApiResult<Option<String>> {
        let Some(thread_id) = thread_id else { return Ok(None) };
        let key = get_thread(db, thread_id)?.and_then(|thread| thread.pin_sort_key);
        match key {
            Some(key) if thread_id != id => Ok(Some(key)),
            _ => Err(stale()),
        }
    };
    if get_thread(db, id)?.and_then(|thread| thread.pinned_at).is_none() {
        return Err(conflict("Thread is not pinned"));
    }
    let previous = key_of(previous_thread_id)?;
    let next = key_of(next_thread_id)?;
    if let (Some(previous), Some(next)) = (&previous, &next)
        && previous >= next
    {
        return Err(stale());
    }
    let key = super::order_keys::order_key_between(previous.as_deref(), next.as_deref())
        .map_err(ApiError::internal)?;
    patch_thread(db, id, &row! { "pinSortKey" => key }, true)?;
    Ok(())
}
