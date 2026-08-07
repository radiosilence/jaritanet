//! `/auth/login`, `/auth/callback`, `/auth/logout`.

use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use crate::auth::cookie::{FLOW_COOKIE, SESSION_COOKIE, clear_cookie, read_cookie, set_cookie};
use crate::auth::oidc::{authorize_url, exchange_code, pkce};
use crate::auth::session::Sessions;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// How long a signed-in session lasts. A week, because the alternative is
/// logging in from a sofa.
pub const SESSION_TTL_SECS: i64 = 7 * 24 * 3600;
/// Long enough to complete a login round-trip and no longer.
pub const FLOW_TTL_SECS: i64 = 600;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/login", get(login))
        .route("/auth/callback", get(callback))
        .route("/auth/logout", get(logout))
}

/// Build a redirect response, appending each cookie as its own `Set-Cookie`
/// header. Needed three times across this file, which is exactly when a
/// helper earns its place.
fn redirect(location: &str, cookies: &[String]) -> Response {
    let mut response = (StatusCode::FOUND, [(header::LOCATION, location)]).into_response();
    let headers = response.headers_mut();
    for cookie in cookies {
        if let Ok(value) = cookie.parse() {
            headers.append(header::SET_COOKIE, value);
        }
    }
    response
}

pub async fn login(State(state): State<AppState>) -> AppResult<Response> {
    let (verifier, challenge) = pkce();
    let csrf = Sessions::token();
    let flow_id = state
        .sessions
        .begin_flow(
            &verifier,
            &csrf,
            std::time::Duration::from_secs(FLOW_TTL_SECS as u64),
        )
        .await;
    let url = authorize_url(
        &state.config.oidc,
        &state.config.redirect_uri(),
        &csrf,
        &challenge,
    );
    Ok(redirect(
        &url,
        &[set_cookie(FLOW_COOKIE, &flow_id, FLOW_TTL_SECS)],
    ))
}

#[derive(serde::Deserialize)]
pub struct Callback {
    pub code: String,
    pub state: String,
}

pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> AppResult<Response> {
    let flow_id = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| read_cookie(h, FLOW_COOKIE))
        .ok_or(AppError::Unauthorized)?;
    let flow = state
        .sessions
        .take_flow(flow_id)
        .await
        .ok_or(AppError::Unauthorized)?;
    if flow.csrf != q.state {
        return Err(AppError::BadRequest("state mismatch".to_string()));
    }

    let sub = exchange_code(
        &state.http,
        &state.config.oidc,
        &state.config.redirect_uri(),
        &q.code,
        &flow.verifier,
    )
    .await?;
    let session_id = state
        .sessions
        .create(
            &sub,
            std::time::Duration::from_secs(SESSION_TTL_SECS as u64),
        )
        .await;

    Ok(redirect(
        "/",
        &[
            set_cookie(SESSION_COOKIE, &session_id, SESSION_TTL_SECS),
            clear_cookie(FLOW_COOKIE),
        ],
    ))
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(id) = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| read_cookie(h, SESSION_COOKIE))
    {
        state.sessions.delete(id).await;
    }
    redirect("/", &[clear_cookie(SESSION_COOKIE)])
}
