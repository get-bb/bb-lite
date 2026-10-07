//! Request extractors that answer a malformed request with the API error envelope
//! (400 `invalid_request`) rather than axum's plain-text rejections.

use axum::Json;
use axum::body::Bytes;
use axum::extract::rejection::{PathRejection, QueryRejection};
use axum::extract::{FromRequest, FromRequestParts, Path, Query, Request};
use http::request::Parts;
use serde::de::DeserializeOwned;

use crate::error::{ApiError, invalid_request};

pub type ApiResponse<T> = Result<Json<T>, ApiError>;

#[derive(Clone, Copy, Debug, Default)]
pub struct ApiJson<T>(pub T);

#[derive(Clone, Copy, Debug, Default)]
pub struct ApiQuery<T>(pub T);

#[derive(Clone, Copy, Debug, Default)]
pub struct ApiPath<T>(pub T);

impl<T, S> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let json_content = request
            .headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.split(';').next().unwrap_or_default().trim().to_ascii_lowercase())
            .is_some_and(|mime| {
                mime == "application/json"
                    || (mime.starts_with("application/") && mime.ends_with("+json"))
            });
        if !json_content {
            return Err(invalid_request("Invalid JSON request body".to_owned()));
        }
        let bytes = match Bytes::from_request(request, state).await {
            Ok(bytes) => bytes,
            Err(rejection) => return Err(invalid_request(rejection.body_text())),
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| invalid_request("Invalid JSON request body".to_owned()))?;
        serde_json::from_value(value)
            .map(Self)
            .map_err(|error| invalid_request(super::validate::from_serde_error(&error)))
    }
}

impl<T, S> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(Self(value)),
            Err(rejection) => Err(query_rejection(rejection)),
        }
    }
}

impl<T, S> FromRequestParts<S> for ApiPath<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Path::<T>::from_request_parts(parts, state).await {
            Ok(Path(value)) => Ok(Self(value)),
            Err(rejection) => Err(path_rejection(rejection)),
        }
    }
}

fn query_rejection(rejection: QueryRejection) -> ApiError {
    match rejection {
        QueryRejection::FailedToDeserializeQueryString(error) => {
            let text = error.body_text();
            let message = text.strip_prefix("Failed to deserialize query string: ").unwrap_or(&text);
            invalid_request(super::validate::from_serde(message))
        }
        other => invalid_request(other.body_text()),
    }
}

fn path_rejection(rejection: PathRejection) -> ApiError {
    match rejection {
        PathRejection::MissingPathParams(missing) => ApiError::internal(missing.body_text()),
        other => invalid_request(other.body_text()),
    }
}
