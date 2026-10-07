use serde::{Deserialize, Serialize};

pub const TERMINAL_COLS_MAX: i64 = 500;
pub const TERMINAL_ROWS_MAX: i64 = 200;
pub const TERMINAL_DATA_MAX_BYTES: usize = 64 * 1024;
pub const TERMINAL_DATA_MAX_BASE64_LENGTH: usize = TERMINAL_DATA_MAX_BYTES.div_ceil(3) * 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalSessionStatus {
    Starting,
    Running,
    Disconnected,
    Exited,
}

impl TerminalSessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Disconnected => "disconnected",
            Self::Exited => "exited",
        }
    }

    /// `isActiveTerminalSessionStatus`.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Starting | Self::Running)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalSessionCloseReason {
    User,
    ProcessExit,
    DaemonDisconnect,
    EnvironmentDestroyed,
    ThreadArchived,
    ThreadDeleted,
    OpenTimeout,
}

impl TerminalSessionCloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::ProcessExit => "process-exit",
            Self::DaemonDisconnect => "daemon-disconnect",
            Self::EnvironmentDestroyed => "environment-destroyed",
            Self::ThreadArchived => "thread-archived",
            Self::ThreadDeleted => "thread-deleted",
            Self::OpenTimeout => "open-timeout",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub thread_id: Option<String>,
    pub environment_id: Option<String>,
    pub host_id: String,
    pub title: String,
    pub initial_cwd: String,
    pub cols: i64,
    pub rows: i64,
    pub status: TerminalSessionStatus,
    pub exit_code: Option<i64>,
    pub close_reason: Option<TerminalSessionCloseReason>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_user_input_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListResponse {
    pub sessions: Vec<TerminalSession>,
}
