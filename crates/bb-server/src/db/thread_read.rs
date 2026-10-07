use serde::{Deserialize, Serialize};

use crate::db::threads::ThreadRow;
use crate::db::{Db, DbResult};
use crate::domain::environment::EnvironmentStatus;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListRow {
    #[serde(flatten)]
    pub row: ThreadRow,
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
        &self.row
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCounts {
    pub thread_id: String,
    pub queued: i64,
    pub failed: i64,
}

pub fn find_thread_list_row(_db: &Db, _id: &str) -> DbResult<Option<ThreadListRow>> {
    todo!("db/thread_read port")
}

pub fn list_sidebar_thread_rows(_db: &Db) -> DbResult<Vec<ThreadListRow>> {
    todo!("db/thread_read port")
}

pub fn list_queue_counts(_db: &Db, _thread_ids: &[String]) -> DbResult<Vec<QueueCounts>> {
    todo!("db/thread_read port")
}
