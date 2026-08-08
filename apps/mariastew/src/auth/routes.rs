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
    let router = Router::new()
        .route("/auth/login", get(login))
        .route("/auth/callback", get(callback))
        .route("/auth/logout", get(logout));
    #[cfg(debug_assertions)]
    let router = router.route("/auth/dev-login", get(dev_login));
    router
}

/// Mints a session for a fixed "dev" subject and skips the OIDC round trip
/// entirely — nothing here reaches Hydra. Mounted alongside `login` and
/// `callback`, outside the auth layer, for the same reason they are: a login
/// route cannot itself require a session.
///
/// Gated on `#[cfg(debug_assertions)]` rather than a runtime flag or an env
/// var. A flag is a value that can end up set in production by accident — a
/// copied `.env`, a stray Helm value — and would need code here to check it
/// on every request. A compile-time gate cannot: `cargo build --release`,
/// what the Dockerfile runs, does not set `debug_assertions`, so this
/// function and the route that reaches it are simply not present in the
/// binary. There is nothing to bypass because there is nothing there.
#[cfg(debug_assertions)]
async fn dev_login(State(state): State<AppState>) -> Response {
    let session_id = state
        .sessions
        .create(
            "dev",
            std::time::Duration::from_secs(SESSION_TTL_SECS as u64),
        )
        .await;
    redirect(
        "/",
        &[set_cookie(SESSION_COOKIE, &session_id, SESSION_TTL_SECS)],
    )
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

// `dev_login` only exists in a debug build, so its tests can't exist in a
// release one either — `cargo test --release` would otherwise fail to find
// the function these call.
#[cfg(debug_assertions)]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::aria2::Aria2;
    use crate::config::Config;

    fn state() -> AppState {
        AppState {
            config: std::sync::Arc::new(Config::fixture()),
            activity: crate::activity::Activity::new(),
            clearing: crate::state::Clearing::default(),
            aria2: Aria2::new(String::new(), reqwest::Client::new()),
            sessions: crate::auth::session::Sessions::new(),
            poll: crate::poll::Poll::new(),
            http: reqwest::Client::new(),
        }
    }

    /// The one behaviour this route exists for: a request with no OIDC round
    /// trip at all still ends up with a real session the store can look back
    /// up, the same shape `callback` produces minus Hydra.
    #[tokio::test]
    async fn dev_login_mints_a_session_the_store_can_retrieve() {
        let app_state = state();
        let response = dev_login(State(app_state.clone())).await;

        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .expect("dev_login must set the session cookie")
            .to_str()
            .unwrap();
        let session_id = cookie
            .split(';')
            .next()
            .unwrap()
            .strip_prefix(&format!("{SESSION_COOKIE}="))
            .expect("cookie must be the session cookie");

        let session = app_state
            .sessions
            .get(session_id)
            .await
            .expect("the id the cookie carries must resolve to a real session");
        assert_eq!(session.sub, "dev");
    }

    #[tokio::test]
    async fn dev_login_redirects_to_the_page() {
        let response = dev_login(State(state())).await;
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(response.headers().get(header::LOCATION).unwrap(), "/");
    }
}
