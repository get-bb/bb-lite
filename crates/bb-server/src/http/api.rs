//! Request extractors that answer a malformed request with the API error envelope
//! (400 `invalid_request`) rather than axum's plain-text rejections.

use axum::Json;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
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
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(json_rejection(rejection)),
        }
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

fn json_rejection(rejection: JsonRejection) -> ApiError {
    invalid_request(rejection.body_text())
}

fn query_rejection(rejection: QueryRejection) -> ApiError {
    invalid_request(rejection.body_text())
}

fn path_rejection(rejection: PathRejection) -> ApiError {
    match rejection {
        PathRejection::MissingPathParams(missing) => ApiError::internal(missing.body_text()),
        other => invalid_request(other.body_text()),
    }
}
