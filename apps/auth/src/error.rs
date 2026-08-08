//! Errors log their cause in full and tell the browser almost nothing.
//!
//! This is the page a person is looking at mid-authentication, so an upstream
//! message quoted back to it describes the identity provider to whoever
//! provoked the error — including someone who provoked it deliberately.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("upstream: {0}")]
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
