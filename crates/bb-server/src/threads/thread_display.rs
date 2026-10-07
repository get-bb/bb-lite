use std::collections::HashMap;

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use crate::context::Ctx;
use crate::db::Db;
use crate::db::event_read::{
    EventWithMeta, HeadState, LEGACY_CODEX_GOAL_EXTENSION_KIND, active_background_task_counts,
    decode_events, list_head_state_events,
};
use crate::db::projects::{get_project_execution_defaults, with_sources};
use crate::db::thread_read::{ThreadListRow, list_queue_counts, list_sidebar_thread_rows};
use crate::db::threads::{MAX_THREAD_HIERARCHY_DEPTH, ancestry};
use crate::domain::environment::EnvironmentStatus;
use crate::domain::project::{Project, ProjectExecutionDefaults, ProjectResponse};
use crate::domain::thread::{Thread, ThreadStatus};
use crate::error::ApiResult;
use crate::runners::registry::RunnerRegistry;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadRuntimeDisplayStatus {
    Status(ThreadStatus),
    Provisioning,
    WaitingForHost,
}

impl ThreadRuntimeDisplayStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Status(status) => status.as_str(),
            Self::Provisioning => "provisioning",
            Self::WaitingForHost => "waiting-for-host",
        }
    }
}

impl Serialize for ThreadRuntimeDisplayStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRuntimeState {
    pub display_status: ThreadRuntimeDisplayStatus,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadActivityState {
    pub active_background_agent_count: i64,
    pub active_background_command_count: i64,
    pub active_goal_count: i64,
    pub active_plan_mode_count: i64,
    pub active_workflow_count: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadQueuedWork {
    None,
    Waiting,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvironmentWorkspaceDisplayKind {
    ManagedWorktree,
    UnmanagedWorktree,
    Other,
}

/// `ThreadListEntry`: one row of the thread list.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListEntry {
    #[serde(flatten)]
    pub thread: Thread,
    pub activity: ThreadActivityState,
    pub queued_work: ThreadQueuedWork,
    pub pin_sort_key: Option<String>,
    pub environment_branch_name: Option<String>,
    pub environment_host_id: Option<String>,
    pub environment_name: Option<String>,
    pub environment_path: Option<String>,
    pub environment_provider_id: Option<String>,
    pub environment_is_worktree: Option<bool>,
    pub environment_workspace_display_kind: EnvironmentWorkspaceDisplayKind,
    pub has_pending_interaction: bool,
    pub runtime: ThreadRuntimeState,
}

/// `ThreadResponse` from `@bb/server-contract`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResponse {
    #[serde(flatten)]
    pub thread: Thread,
    pub runtime: ThreadRuntimeState,
    pub active_background_agent_count: i64,
    pub can_restore_environment: bool,
    pub can_spawn_child: bool,
    pub queued_message_count: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWithThreads {
    #[serde(flatten)]
    pub project: ProjectResponse,
    pub threads: Vec<ThreadListEntry>,
    pub default_execution_options: Option<ProjectExecutionDefaults>,
}

fn thread_display_status(
    runners: &RunnerRegistry,
    row: &ThreadListRow,
) -> ThreadRuntimeDisplayStatus {
    let preparing = matches!(
        row.environment_status,
        Some(EnvironmentStatus::Creating | EnvironmentStatus::Provisioning)
    );
    if row.status == ThreadStatus::Starting && preparing {
        return ThreadRuntimeDisplayStatus::Provisioning;
    }
    let host_gone =
        row.environment_host_id.as_deref().is_some_and(|host_id| !runners.is_connected(host_id));
    if row.status == ThreadStatus::Active && host_gone {
        ThreadRuntimeDisplayStatus::WaitingForHost
    } else {
        ThreadRuntimeDisplayStatus::Status(row.status)
    }
}

const GOAL_STATUSES: [&str; 4] = ["active", "paused", "budgetLimited", "complete"];

fn goal_payload(payload: &Value) -> Option<Option<&Map<String, Value>>> {
    if payload.is_null() {
        return Some(None);
    }
    let goal = payload.as_object()?;
    let status = goal.get("status").and_then(Value::as_str)?;
    let budget = goal.get("tokenBudget")?;
    let valid = goal.get("objective").is_some_and(Value::is_string)
        && GOAL_STATUSES.contains(&status)
        && (budget.is_null() || budget.is_number())
        && goal.get("tokensUsed").is_some_and(Value::is_number)
        && goal.get("timeUsedSeconds").is_some_and(Value::is_number);
    valid.then_some(Some(goal))
}

/// `extractThreadTimelineGoal` from `@bb/thread-view`, ported privately here
/// until the timeline crate's port exists; deduplicate then.
fn extract_thread_timeline_goal(events: &[EventWithMeta]) -> Option<Value> {
    let mut ordered: Vec<&EventWithMeta> = events.iter().collect();
    ordered.sort_by_key(|event| event.meta.seq);
    let mut best: Option<(i64, Option<Value>)> = None;
    for EventWithMeta { event, meta } in ordered {
        let kind = event.get("kind").and_then(Value::as_str);
        if event.get("type").and_then(Value::as_str) != Some("thread/extensionState/updated")
            || kind != Some(LEGACY_CODEX_GOAL_EXTENSION_KIND)
        {
            continue;
        }
        let Some(payload) = goal_payload(event.get("payload").unwrap_or(&Value::Null)) else {
            continue;
        };
        if best.as_ref().is_some_and(|(seq, _)| meta.seq <= *seq) {
            continue;
        }
        let goal = payload.map(|payload| {
            let mut goal = Map::new();
            goal.insert("sourceSeq".into(), meta.seq.into());
            goal.insert("updatedAt".into(), meta.created_at.into());
            goal.extend(payload.iter().map(|(key, value)| (key.clone(), value.clone())));
            Value::Object(goal)
        });
        best = Some((meta.seq, goal));
    }
    best.and_then(|(_, goal)| goal)
}

fn thread_activities(
    db: &Db,
    threads: &[ThreadListRow],
) -> ApiResult<HashMap<String, ThreadActivityState>> {
    let thread_ids: Vec<String> = threads.iter().map(|thread| thread.id.clone()).collect();
    let mut activities: HashMap<String, ThreadActivityState> =
        active_background_task_counts(db, &thread_ids)?
            .into_iter()
            .map(|counts| {
                let activity = ThreadActivityState {
                    active_background_agent_count: counts.active_background_agent_count,
                    active_background_command_count: counts.active_background_command_count,
                    active_workflow_count: counts.active_workflow_count,
                    ..ThreadActivityState::default()
                };
                (counts.thread_id, activity)
            })
            .collect();
    let goals = list_head_state_events(db, &thread_ids, HeadState::Goal)?;
    for thread in threads {
        let states: Vec<_> =
            goals.iter().filter(|row| row.thread_id == thread.id).cloned().collect();
        let goal = extract_thread_timeline_goal(&decode_events(db, &states));
        if goal.as_ref().and_then(|goal| goal.get("status")).and_then(Value::as_str)
            != Some("active")
        {
            continue;
        }
        activities.entry(thread.id.clone()).or_default().active_goal_count = 1;
    }
    Ok(activities)
}

fn thread_list_entry(
    row: &ThreadListRow,
    activity: ThreadActivityState,
    failed_queue: Option<bool>,
    display_status: ThreadRuntimeDisplayStatus,
) -> ThreadListEntry {
    let worktree = row.environment_is_worktree;
    let managed = row.environment_provider_id.as_deref() == Some("git-worktree");
    let kind = if managed {
        EnvironmentWorkspaceDisplayKind::ManagedWorktree
    } else if worktree == Some(1) {
        EnvironmentWorkspaceDisplayKind::UnmanagedWorktree
    } else {
        EnvironmentWorkspaceDisplayKind::Other
    };
    ThreadListEntry {
        thread: row.thread.thread.clone(),
        activity,
        queued_work: match failed_queue {
            None => ThreadQueuedWork::None,
            Some(true) => ThreadQueuedWork::Failed,
            Some(false) => ThreadQueuedWork::Waiting,
        },
        pin_sort_key: row.pin_sort_key.clone(),
        environment_branch_name: row.environment_branch_name.clone(),
        environment_host_id: row.environment_host_id.clone(),
        environment_name: row.environment_name.clone(),
        environment_path: row.environment_path.clone(),
        environment_provider_id: row.environment_provider_id.clone(),
        environment_is_worktree: worktree.map(|worktree| worktree == 1),
        environment_workspace_display_kind: kind,
        has_pending_interaction: row.has_pending_interaction == 1,
        runtime: ThreadRuntimeState { display_status },
    }
}

pub fn to_thread_list_entries(
    ctx: &Ctx,
    rows: &[ThreadListRow],
) -> ApiResult<Vec<ThreadListEntry>> {
    let thread_ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
    let activities = thread_activities(&ctx.db, rows)?;
    let failed_queues: HashMap<String, bool> = list_queue_counts(&ctx.db, &thread_ids)?
        .into_iter()
        .map(|queue| (queue.thread_id, queue.failed > 0))
        .collect();
    Ok(rows
        .iter()
        .map(|row| {
            let activity = activities.get(&row.id).copied().unwrap_or_default();
            let failed = failed_queues.get(&row.id).copied();
            thread_list_entry(row, activity, failed, thread_display_status(&ctx.runners, row))
        })
        .collect())
}

fn thread_response(
    db: &Db,
    row: &ThreadListRow,
    display_status: ThreadRuntimeDisplayStatus,
    queued_message_count: i64,
) -> ApiResult<ThreadResponse> {
    let ids = [row.id.clone()];
    let counts = active_background_task_counts(db, &ids)?.into_iter().next();
    Ok(ThreadResponse {
        thread: row.thread.thread.clone(),
        runtime: ThreadRuntimeState { display_status },
        active_background_agent_count: counts
            .map_or(0, |counts| counts.active_background_agent_count),
        can_restore_environment: false,
        can_spawn_child: ancestry(db, row)?.len() < MAX_THREAD_HIERARCHY_DEPTH,
        queued_message_count,
    })
}

pub fn to_thread_response(ctx: &Ctx, row: &ThreadListRow) -> ApiResult<ThreadResponse> {
    let queue = list_queue_counts(&ctx.db, std::slice::from_ref(&row.id))?.into_iter().next();
    let display_status = thread_display_status(&ctx.runners, row);
    thread_response(&ctx.db, row, display_status, queue.map_or(0, |queue| queue.queued))
}

pub fn list_projects_with_threads(
    ctx: &Ctx,
    projects: Vec<Project>,
) -> ApiResult<Vec<ProjectWithThreads>> {
    let db = &ctx.db;
    let entries = to_thread_list_entries(ctx, &list_sidebar_thread_rows(db)?)?;
    with_sources(db, projects)?
        .into_iter()
        .map(|project| {
            let id = project.project.id.clone();
            Ok(ProjectWithThreads {
                threads: entries
                    .iter()
                    .filter(|thread| thread.thread.project_id == id)
                    .cloned()
                    .collect(),
                default_execution_options: get_project_execution_defaults(db, &id)?,
                project,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::db::threads::ThreadRow;

    fn event(seq: i64, payload: Value) -> EventWithMeta {
        serde_json::from_value(json!({
            "event": {
                "type": "thread/extensionState/updated",
                "kind": LEGACY_CODEX_GOAL_EXTENSION_KIND,
                "payload": payload,
            },
            "meta": { "id": format!("evt_{seq}"), "seq": seq, "createdAt": seq * 10 },
        }))
        .unwrap()
    }

    fn goal(status: &str) -> Value {
        json!({
            "objective": "ship", "status": status, "tokenBudget": null,
            "tokensUsed": 1, "timeUsedSeconds": 2,
        })
    }

    #[test]
    fn latest_valid_goal_wins() {
        let events = [event(3, goal("paused")), event(1, goal("active")), event(4, json!(7))];
        let found = extract_thread_timeline_goal(&events).unwrap();
        assert_eq!(found["status"], "paused");
        assert_eq!(found["sourceSeq"], 3);
        assert_eq!(found["updatedAt"], 30);
        assert_eq!(
            extract_thread_timeline_goal(&[event(1, goal("active")), event(2, Value::Null)]),
            None
        );
    }

    fn list_row() -> ThreadListRow {
        let thread: ThreadRow = serde_json::from_value(json!({
            "id": "thr_a", "projectId": "proj_a", "environmentId": "env_a",
            "providerId": "codex", "title": "T", "titleFallback": null, "sectionId": null,
            "status": "idle", "parentThreadId": null, "lifecycleOwnerThreadId": null,
            "sourceThreadId": null, "originKind": null, "originPluginId": null,
            "visibility": "visible", "archivedAt": null, "pinnedAt": null, "deletedAt": null,
            "lastReadAt": null, "latestAttentionAt": 5, "createdAt": 1, "updatedAt": 2,
            "providerThreadId": null, "activeTurnId": null, "model": "m",
            "reasoningLevel": null, "permissionMode": null, "serviceTier": null,
            "modelOverride": null, "reasoningLevelOverride": null, "startupContext": null,
            "pinSortKey": "a0", "storageDeletedAt": null,
        }))
        .unwrap();
        ThreadListRow {
            thread,
            environment_branch_name: Some("bb/x".into()),
            environment_host_id: Some("host_a".into()),
            environment_is_worktree: Some(1),
            environment_name: None,
            environment_path: Some("/w".into()),
            environment_provider_id: Some("local".into()),
            environment_status: Some(EnvironmentStatus::Ready),
            has_pending_interaction: 1,
        }
    }

    #[test]
    fn list_entry_json() {
        let row = list_row();
        let activity = ThreadActivityState { active_goal_count: 1, ..Default::default() };
        let status = ThreadRuntimeDisplayStatus::WaitingForHost;
        let entry =
            serde_json::to_value(thread_list_entry(&row, activity, Some(true), status)).unwrap();
        let mut expected = serde_json::to_value(&row.thread.thread).unwrap();
        let extra = json!({
            "activity": {
                "activeBackgroundAgentCount": 0, "activeBackgroundCommandCount": 0,
                "activeGoalCount": 1, "activePlanModeCount": 0, "activeWorkflowCount": 0,
            },
            "queuedWork": "failed", "pinSortKey": "a0", "environmentBranchName": "bb/x",
            "environmentHostId": "host_a", "environmentName": null, "environmentPath": "/w",
            "environmentProviderId": "local", "environmentIsWorktree": true,
            "environmentWorkspaceDisplayKind": "unmanaged-worktree",
            "hasPendingInteraction": true, "runtime": { "displayStatus": "waiting-for-host" },
        });
        expected.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert_eq!(entry, expected);
        assert!(entry.get("model").is_none());
    }

    #[test]
    fn response_json() {
        let db = Db::open_in_memory(None).unwrap();
        let row = list_row();
        let status = ThreadRuntimeDisplayStatus::Status(ThreadStatus::Idle);
        let response =
            serde_json::to_value(thread_response(&db, &row, status, 2).unwrap()).unwrap();
        assert_eq!(response["runtime"], json!({ "displayStatus": "idle" }));
        assert_eq!(response["activeBackgroundAgentCount"], 0);
        assert_eq!(response["canRestoreEnvironment"], false);
        assert_eq!(response["canSpawnChild"], true);
        assert_eq!(response["queuedMessageCount"], 2);
        assert_eq!(response["id"], "thr_a");
        assert!(response.get("pinSortKey").is_none());
    }
}
