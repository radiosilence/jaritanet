//! Errors log their cause in full and tell the client almost nothing.
//!
//! This sits in front of aria2's RPC and the media tree, so an upstream message
//! quoted back to the browser is a description of the filesystem behind it.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("aria2: {0}")]
    Upstream(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Upstream(_) => StatusCode::BAD_GATEWAY,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        if status.is_server_error() {
            tracing::error!(error = %self, "request failed");
        } else {
            tracing::debug!(error = %self, "request rejected");
        }
        // Only a rejection the caller can act on is worth repeating back; the
        // rest are a status code and a log line.
        let public = match &self {
            AppError::BadRequest(m) => m.clone(),
            AppError::Unauthorized => "unauthorized".to_string(),
            AppError::Upstream(_) => "upstream error".to_string(),
            AppError::Internal(_) => "internal error".to_string(),
        };
        (status, public).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
