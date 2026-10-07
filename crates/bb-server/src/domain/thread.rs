use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadStatus {
    Pending,
    Idle,
    Starting,
    Active,
    Stopping,
    Error,
}

impl ThreadStatus {
    pub const ALL: [ThreadStatus; 6] = [
        ThreadStatus::Pending,
        ThreadStatus::Idle,
        ThreadStatus::Starting,
        ThreadStatus::Active,
        ThreadStatus::Stopping,
        ThreadStatus::Error,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ThreadStatus::Pending => "pending",
            ThreadStatus::Idle => "idle",
            ThreadStatus::Starting => "starting",
            ThreadStatus::Active => "active",
            ThreadStatus::Stopping => "stopping",
            ThreadStatus::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadVisibility {
    #[default]
    Visible,
    Hidden,
}

impl ThreadVisibility {
    pub fn as_str(self) -> &'static str {
        match self {
            ThreadVisibility::Visible => "visible",
            ThreadVisibility::Hidden => "hidden",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadOriginKind {
    Fork,
}

impl ThreadOriginKind {
    pub fn as_str(self) -> &'static str {
        "fork"
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub project_id: String,
    pub environment_id: Option<String>,
    pub provider_id: String,
    pub title: Option<String>,
    pub title_fallback: Option<String>,
    pub section_id: Option<String>,
    pub status: ThreadStatus,
    pub parent_thread_id: Option<String>,
    pub lifecycle_owner_thread_id: Option<String>,
    pub source_thread_id: Option<String>,
    pub origin_kind: Option<ThreadOriginKind>,
    pub origin_plugin_id: Option<String>,
    pub visibility: ThreadVisibility,
    pub archived_at: Option<i64>,
    pub pinned_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub last_read_at: Option<i64>,
    pub latest_attention_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ThreadLifecycleEventType {
    #[serde(rename = "run.preparing")]
    RunPreparing,
    #[serde(rename = "run.started")]
    RunStarted,
    #[serde(rename = "run.succeeded")]
    RunSucceeded,
    #[serde(rename = "run.failed")]
    RunFailed,
    #[serde(rename = "stop.requested")]
    StopRequested,
    #[serde(rename = "stop.settled")]
    StopSettled,
}

impl ThreadLifecycleEventType {
    pub const ALL: [ThreadLifecycleEventType; 6] = [
        ThreadLifecycleEventType::RunPreparing,
        ThreadLifecycleEventType::RunStarted,
        ThreadLifecycleEventType::RunSucceeded,
        ThreadLifecycleEventType::RunFailed,
        ThreadLifecycleEventType::StopRequested,
        ThreadLifecycleEventType::StopSettled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ThreadLifecycleEventType::RunPreparing => "run.preparing",
            ThreadLifecycleEventType::RunStarted => "run.started",
            ThreadLifecycleEventType::RunSucceeded => "run.succeeded",
            ThreadLifecycleEventType::RunFailed => "run.failed",
            ThreadLifecycleEventType::StopRequested => "stop.requested",
            ThreadLifecycleEventType::StopSettled => "stop.settled",
        }
    }

    /// `(not_archived, not_deleted)`: the row states under which the event is superseded.
    fn predicates(self) -> (bool, bool) {
        match self {
            ThreadLifecycleEventType::RunPreparing | ThreadLifecycleEventType::RunStarted => {
                (true, true)
            }
            ThreadLifecycleEventType::RunFailed => (false, true),
            ThreadLifecycleEventType::RunSucceeded
            | ThreadLifecycleEventType::StopRequested
            | ThreadLifecycleEventType::StopSettled => (false, false),
        }
    }
}

/// `THREAD_LIFECYCLE[from][event]`: the status the event moves a thread to, if any.
pub fn thread_lifecycle_transition(
    from: ThreadStatus,
    event: ThreadLifecycleEventType,
) -> Option<ThreadStatus> {
    use ThreadLifecycleEventType as E;
    use ThreadStatus as S;
    Some(match (from, event) {
        (S::Pending, E::RunPreparing) => S::Starting,
        (S::Idle, E::RunPreparing) => S::Starting,
        (S::Idle, E::RunStarted) => S::Active,
        (S::Starting, E::RunStarted) => S::Active,
        (S::Starting, E::RunSucceeded) => S::Idle,
        (S::Starting, E::RunFailed) => S::Error,
        (S::Starting, E::StopRequested) => S::Stopping,
        (S::Active, E::RunSucceeded) => S::Idle,
        (S::Active, E::RunFailed) => S::Error,
        (S::Active, E::StopRequested) => S::Stopping,
        (S::Stopping, E::StopSettled) => S::Idle,
        (S::Stopping, E::RunSucceeded) => S::Idle,
        (S::Stopping, E::RunFailed) => S::Error,
        (S::Error, E::RunPreparing) => S::Starting,
        (S::Error, E::RunStarted) => S::Active,
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThreadLifecycleNoopReason {
    IllegalTransition,
    Superseded,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ThreadLifecycleEvaluation {
    To(ThreadStatus),
    Noop { noop: ThreadLifecycleNoopReason, detail: String },
}

pub struct ThreadLifecycleRowState {
    pub archived_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub status: ThreadStatus,
}

pub fn evaluate_thread_lifecycle_event(
    event: ThreadLifecycleEventType,
    thread: &ThreadLifecycleRowState,
) -> ThreadLifecycleEvaluation {
    let (not_archived, not_deleted) = event.predicates();
    let superseded = |detail: &str| ThreadLifecycleEvaluation::Noop {
        noop: ThreadLifecycleNoopReason::Superseded,
        detail: detail.to_owned(),
    };
    if not_deleted && thread.deleted_at.is_some() {
        return superseded("deletedAt set");
    }
    if not_archived && thread.archived_at.is_some() {
        return superseded("archivedAt set");
    }
    match thread_lifecycle_transition(thread.status, event) {
        Some(to) => ThreadLifecycleEvaluation::To(to),
        None => ThreadLifecycleEvaluation::Noop {
            noop: ThreadLifecycleNoopReason::IllegalTransition,
            detail: format!(
                "no transition for {} from status {}",
                event.as_str(),
                thread.status.as_str()
            ),
        },
    }
}
