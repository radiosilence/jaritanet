//! The login and consent provider Hydra delegates to, plus the upstream
//! callback that serves it.
//!
//! Nothing here learns which application the person is signing in to, beyond
//! the name shown on a consent screen. Hydra carries that in the challenge and
//! redirects the browser to whichever client began the flow, which is why one
//! instance serves every relying party and why adding one requires nothing
//! from GitHub.

use askama::Template;
use axum::Form;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng as _;
use serde::Deserialize;

use crate::cookie::{self, FLOW_COOKIE};
use crate::error::{AppError, AppResult};
use crate::github;
use crate::hydra::SessionClaims;
use crate::state::AppState;
use crate::store::{FLOW_TTL_SECS, Flow};

fn csrf_token() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn redirect(location: &str, cookies: &[String]) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, location)
        .body(Body::empty())
        .expect("a location header and an empty body are always a valid response");
    for c in cookies {
        if let Ok(value) = HeaderValue::from_str(c) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

#[derive(Template)]
#[template(path = "index.html")]
struct IndexTemplate;

#[derive(Template)]
#[template(path = "consent.html")]
struct ConsentTemplate {
    challenge: String,
    client: String,
    login: String,
    scopes: Vec<String>,
    audience: Vec<String>,
}

/// There is nothing to sign in *to* here. This service authenticates people for
/// other services and holds no account of its own.
pub async fn index() -> impl IntoResponse {
    Html(IndexTemplate.render().unwrap_or_default())
}

#[derive(Deserialize)]
pub struct LoginQuery {
    login_challenge: String,
}

/// Hydra sends the browser here to have the person authenticated.
///
/// When Hydra already holds a session it sets `skip`, and the right answer is
/// to confirm the subject it already has rather than bounce to GitHub — that
/// is what makes signing in to a second service seamless.
pub async fn login(
    State(state): State<AppState>,
    Query(q): Query<LoginQuery>,
) -> AppResult<Response> {
    let request = state
        .hydra
        .get_login(&q.login_challenge)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    // A session accepted before the address became a claim carries none, and
    // nothing here can reconstruct one — so that session is not skipped, and
    // the upstream is asked again. GitHub's own session usually makes the
    // round-trip invisible, which is what makes this a migration rather than a
    // forced sign-out.
    let claims = request.claims();
    if request.skip && !claims.email.is_empty() {
        let redirect_to = state
            .hydra
            .accept_login(&q.login_challenge, &request.subject, &claims)
            .await
            .map_err(|e| AppError::Upstream(e.to_string()))?;
        return Ok(redirect(&redirect_to, &[]));
    }

    let csrf = csrf_token();
    let flow_id = state
        .store
        .create_flow(&Flow {
            csrf: csrf.clone(),
            login_challenge: q.login_challenge,
        })
        .await
        .map_err(AppError::Internal)?;

    Ok(redirect(
        &github::authorize_url(&state.config, &csrf),
        &[cookie::set_cookie(
            FLOW_COOKIE,
            &flow_id,
            FLOW_TTL_SECS as i64,
        )],
    ))
}

#[derive(Deserialize)]
pub struct GithubCallback {
    code: String,
    state: String,
}

pub async fn github_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<GithubCallback>,
) -> AppResult<Response> {
    let flow_id = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|c| cookie::read_cookie(c, FLOW_COOKIE))
        .ok_or(AppError::Unauthorized)?;

    // Taken, not read: a replayed callback finds nothing rather than a second
    // usable flow.
    let flow = state
        .store
        .take_flow(flow_id)
        .await
        .map_err(AppError::Internal)?
        .ok_or(AppError::Unauthorized)?;

    if flow.csrf != q.state {
        return Err(AppError::BadRequest("state mismatch".into()));
    }

    let identity = github::exchange_code(&state.config, &state.http, &q.code)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    // The control that makes open client registration survivable: a registered
    // client is useless without a token, and a token issues only to somebody
    // named here.
    if !state.config.login_allowed(&identity.login) {
        tracing::warn!(login = %identity.login, "rejected login: not in GH_ALLOWED");
        return Err(AppError::Unauthorized);
    }

    let claims = SessionClaims {
        login: identity.login,
        email: identity.email,
        email_verified: identity.email_verified,
    };
    let redirect_to = state
        .hydra
        .accept_login(&flow.login_challenge, &identity.subject, &claims)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    Ok(redirect(&redirect_to, &[cookie::clear_cookie(FLOW_COOKIE)]))
}

#[derive(Deserialize)]
pub struct ConsentQuery {
    consent_challenge: String,
}

/// A client this deployment registered is granted without asking; anything that
/// registered itself is asked about.
///
/// The asymmetry is the point. Registration has to stay open — Claude registers
/// its own client — so without it a self-registered client could request, and
/// silently receive, a token audienced at any service trusting this issuer.
pub async fn consent(
    State(state): State<AppState>,
    Query(q): Query<ConsentQuery>,
) -> AppResult<Response> {
    let request = state
        .hydra
        .get_consent(&q.consent_challenge)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    if state
        .config
        .first_party(&request.client.client_id)
        .is_some()
    {
        let redirect_to = state
            .hydra
            .accept_consent(&q.consent_challenge, &request)
            .await
            .map_err(|e| AppError::Upstream(e.to_string()))?;
        return Ok(redirect(&redirect_to, &[]));
    }

    tracing::info!(
        client_id = %request.client.client_id,
        subject = %request.subject,
        "asking for consent: client is not first-party"
    );

    let page = ConsentTemplate {
        challenge: q.consent_challenge,
        client: request.client_label().to_string(),
        login: request.claims().login,
        scopes: request.requested_scope.clone(),
        audience: request.requested_access_token_audience.clone(),
    };
    Ok(Html(page.render().map_err(|e| AppError::Internal(e.into()))?).into_response())
}

#[derive(Deserialize)]
pub struct ConsentDecision {
    challenge: String,
    /// Present only when the approve button was the one pressed.
    #[serde(default)]
    approve: Option<String>,
}

/// The decision from the consent screen.
///
/// The challenge is Hydra's own one-shot, high-entropy value and is not
/// guessable by a third party, so it carries the weight a separate CSRF token
/// would: a forged post cannot name a live consent.
pub async fn consent_decision(
    State(state): State<AppState>,
    Form(decision): Form<ConsentDecision>,
) -> AppResult<Response> {
    if decision.approve.is_none() {
        let redirect_to = state
            .hydra
            .reject_consent(&decision.challenge)
            .await
            .map_err(|e| AppError::Upstream(e.to_string()))?;
        return Ok(redirect(&redirect_to, &[]));
    }

    let request = state
        .hydra
        .get_consent(&decision.challenge)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;
    let redirect_to = state
        .hydra
        .accept_consent(&decision.challenge, &request)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;
    Ok(redirect(&redirect_to, &[]))
}
