use std::fmt;
use std::io;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunnerErrorCode {
    CompetingTurn,
    StaleTurn,
    SessionNotFound,
    MissingExecutable,
    AuthRequired,
    RateLimited,
    PathNotFound,
    NotGitRepo,
    PermissionDenied,
    InvalidPath,
    FileTooLarge,
    Conflict,
    NoChanges,
    TerminalNotFound,
    Unavailable,
    Failed,
}

impl RunnerErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CompetingTurn => "competing_turn",
            Self::StaleTurn => "stale_turn",
            Self::SessionNotFound => "session_not_found",
            Self::MissingExecutable => "missing_executable",
            Self::AuthRequired => "auth_required",
            Self::RateLimited => "rate_limited",
            Self::PathNotFound => "path_not_found",
            Self::NotGitRepo => "not_git_repo",
            Self::PermissionDenied => "permission_denied",
            Self::InvalidPath => "invalid_path",
            Self::FileTooLarge => "file_too_large",
            Self::Conflict => "conflict",
            Self::NoChanges => "no_changes",
            Self::TerminalNotFound => "terminal_not_found",
            Self::Unavailable => "unavailable",
            Self::Failed => "failed",
        }
    }

    pub fn parse(text: &str) -> Self {
        serde_json::from_value(serde_json::Value::String(text.to_owned())).unwrap_or(Self::Failed)
    }
}

impl fmt::Display for RunnerErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunnerError {
    pub code: RunnerErrorCode,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

pub type RunnerResult<T> = Result<T, RunnerError>;

impl RunnerError {
    pub fn new(code: RunnerErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), retryable: false }
    }

    pub fn retryable(code: RunnerErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), retryable: true }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(RunnerErrorCode::Failed, message)
    }

    pub fn connection_lost() -> Self {
        Self::retryable(
            RunnerErrorCode::Unavailable,
            "The connection to this machine's runner was lost",
        )
    }
}

pub fn fail<T>(code: RunnerErrorCode, message: impl Into<String>) -> RunnerResult<T> {
    Err(RunnerError::new(code, message))
}

impl fmt::Display for RunnerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RunnerError {}

pub fn io_error_code(error: &io::Error) -> RunnerErrorCode {
    use io::ErrorKind as Kind;
    if error.raw_os_error() == Some(libc::ELOOP) {
        return RunnerErrorCode::InvalidPath;
    }
    match error.kind() {
        Kind::NotFound => RunnerErrorCode::PathNotFound,
        Kind::PermissionDenied => RunnerErrorCode::PermissionDenied,
        Kind::NotADirectory | Kind::IsADirectory | Kind::DirectoryNotEmpty => {
            RunnerErrorCode::InvalidPath
        }
        Kind::AlreadyExists => RunnerErrorCode::Conflict,
        _ => RunnerErrorCode::Failed,
    }
}

impl From<io::Error> for RunnerError {
    fn from(error: io::Error) -> Self {
        Self::new(io_error_code(&error), error.to_string())
    }
}

impl From<serde_json::Error> for RunnerError {
    fn from(error: serde_json::Error) -> Self {
        Self::failed(error.to_string())
    }
}
