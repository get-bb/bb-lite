//! The error every server operation returns: an HTTP status and the
//! `{code, message, details?, retryable?}` body clients receive.

use std::fmt;

use axum::Json;
use axum::response::{IntoResponse, Response};
use bb_core::{RunnerError, RunnerErrorCode};
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::DbError;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApiErrorBody {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub body: ApiErrorBody,
    /// Set for an unexpected failure: what is logged, never sent.
    pub cause: Option<String>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        let body = ApiErrorBody {
            code: code.to_owned(),
            message: message.into(),
            details: None,
            retryable: None,
        };
        Self { status, body, cause: None }
    }

    pub fn details(mut self, details: Value) -> Self {
        self.body.details = Some(details);
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.body.retryable = Some(retryable);
        self
    }

    /// An unexpected failure: answers 500 "Internal server error" and keeps
    /// `cause` for the log.
    pub fn internal(cause: impl fmt::Display) -> Self {
        let mut error = Self::new(500, "internal_error", "Internal server error");
        error.cause = Some(cause.to_string());
        error
    }

    pub fn is_internal(&self) -> bool {
        self.cause.is_some()
    }

    pub fn code(&self) -> &str {
        &self.body.code
    }
}

pub fn not_found() -> ApiError {
    ApiError::new(404, "not_found", "Not found")
}

pub fn not_found_message(message: impl Into<String>) -> ApiError {
    ApiError::new(404, "not_found", message)
}

pub fn invalid_request(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "invalid_request", message)
}

pub fn conflict(message: impl Into<String>) -> ApiError {
    ApiError::new(409, "invalid_request", message)
}

pub fn forbidden(message: impl Into<String>) -> ApiError {
    ApiError::new(403, "forbidden", message)
}

pub fn thread_not_found() -> ApiError {
    ApiError::new(404, "thread_not_found", "Thread not found")
}

pub fn host_unavailable() -> ApiError {
    let details = json!({
        "reason": "disconnected",
        "hostStatus": "disconnected",
        "suspendedAt": null,
        "destroyedAt": null,
    });
    ApiError::new(502, "host_unavailable", "Host is not connected")
        .details(details)
        .retryable(false)
}

fn runner_error_status(code: RunnerErrorCode) -> u16 {
    if code.as_str().ends_with("_not_found") {
        404
    } else if code == RunnerErrorCode::Unavailable {
        503
    } else if code == RunnerErrorCode::Failed {
        502
    } else {
        409
    }
}

impl From<RunnerError> for ApiError {
    fn from(error: RunnerError) -> Self {
        ApiError::new(runner_error_status(error.code), error.code.as_str(), error.message)
            .retryable(error.retryable)
    }
}

impl From<DbError> for ApiError {
    fn from(error: DbError) -> Self {
        ApiError::internal(error)
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        ApiError::internal(error)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        ApiError::internal(error)
    }
}

impl ApiError {
    /// The runner error this API error was made from, when its code is one.
    pub fn runner_code(&self) -> Option<RunnerErrorCode> {
        let code = RunnerErrorCode::parse(&self.body.code);
        (code.as_str() == self.body.code).then_some(code)
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.cause.as_deref().unwrap_or(&self.body.message))
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut response = (status, Json(&self.body)).into_response();
        response.extensions_mut().insert(self);
        response
    }
}

pub fn error_message(error: &dyn fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_errors_map_to_statuses() {
        let status = |code| ApiError::from(RunnerError::new(code, "x")).status;
        assert_eq!(status(RunnerErrorCode::PathNotFound), 404);
        assert_eq!(status(RunnerErrorCode::TerminalNotFound), 404);
        assert_eq!(status(RunnerErrorCode::Unavailable), 503);
        assert_eq!(status(RunnerErrorCode::Failed), 502);
        assert_eq!(status(RunnerErrorCode::Conflict), 409);
        let error = ApiError::from(RunnerError::retryable(RunnerErrorCode::Unavailable, "gone"));
        assert_eq!(
            serde_json::to_value(&error.body).unwrap(),
            json!({"code": "unavailable", "message": "gone", "retryable": true})
        );
        assert_eq!(error.runner_code(), Some(RunnerErrorCode::Unavailable));
        assert_eq!(not_found().runner_code(), None);
    }

    #[test]
    fn internal_errors_hide_their_cause() {
        let error = ApiError::internal("disk on fire");
        assert_eq!(error.body.message, "Internal server error");
        assert_eq!(error.to_string(), "disk on fire");
    }
}
