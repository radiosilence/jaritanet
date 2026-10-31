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

/// A 302 for a GET. The location usually comes from Hydra, so a value that
/// cannot be a header is an upstream fault answered with an error, not a panic
/// that the release profile turns into a dead process.
fn redirect(location: &str, cookies: &[String]) -> AppResult<Response> {
    let location = HeaderValue::from_str(location)
        .map_err(|_| AppError::Upstream("redirect target is not a valid header".into()))?;
    let mut response = StatusCode::FOUND.into_response();
    response.headers_mut().insert(header::LOCATION, location);
    for c in cookies {
        if let Ok(value) = HeaderValue::from_str(c) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    Ok(response)
}

#[derive(Template)]
#[template(path = "index.html")]
struct IndexTemplate;

#[derive(Template)]
#[template(path = "expired.html")]
struct ExpiredTemplate;

/// The callback when no flow is bound to this browser: it expired, or the
/// cookie never arrived. There is no challenge to reject at Hydra, so the
/// person is told to start again rather than shown a bare 401.
fn expired() -> Response {
    let html = ExpiredTemplate.render().unwrap_or_default();
    (StatusCode::UNAUTHORIZED, Html(html)).into_response()
}

#[derive(Template)]
#[template(path = "continue.html")]
struct ContinueTemplate<'a> {
    heading: &'a str,
    to: &'a str,
}

/// Where a consent decision sends the browser next. See `continue.html` for
/// why this is a page and not a redirect.
fn continue_to(heading: &str, to: &str) -> AppResult<Response> {
    let html = ContinueTemplate { heading, to }
        .render()
        .map_err(|e| AppError::Upstream(e.to_string()))?;
    Ok(Html(html).into_response())
}

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
        return redirect(&redirect_to, &[]);
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

    redirect(
        &github::authorize_url(&state.config, &csrf),
        &[cookie::set_cookie(
            FLOW_COOKIE,
            &flow_id,
            FLOW_TTL_SECS as i64,
        )],
    )
}

#[derive(Deserialize)]
pub struct GithubCallback {
    /// Absent when GitHub sends the person back without authorising, which it
    /// reports in `error` instead.
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    error: Option<String>,
    state: String,
}

/// The OAuth error a relying party is told when GitHub returned no code.
/// Cancelling is the person refusing; anything else GitHub reports is a fault
/// on this side of the flow, not a decision the person made.
fn upstream_error(github_error: Option<&str>) -> &'static str {
    match github_error {
        Some("access_denied") => "access_denied",
        _ => "server_error",
    }
}

/// End the login at Hydra rather than here, so the relying party receives an
/// OAuth error it can show instead of waiting on a flow nobody will finish.
async fn reject(
    state: &AppState,
    challenge: &str,
    error: &str,
    description: &str,
) -> AppResult<Response> {
    let redirect_to = state
        .hydra
        .reject_login(challenge, error, description)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;
    redirect(&redirect_to, &[cookie::clear_cookie(FLOW_COOKIE)])
}

pub async fn github_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<GithubCallback>,
) -> AppResult<Response> {
    let Some(flow_id) = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|c| cookie::read_cookie(c, FLOW_COOKIE))
    else {
        return Ok(expired());
    };

    // Taken, not read: a replayed callback finds nothing rather than a second
    // usable flow.
    let Some(flow) = state
        .store
        .take_flow(flow_id)
        .await
        .map_err(AppError::Internal)?
    else {
        return Ok(expired());
    };

    if flow.csrf != q.state {
        return Err(AppError::BadRequest("state mismatch".into()));
    }

    let Some(code) = q.code else {
        tracing::info!(error = ?q.error, "GitHub returned no code");
        return reject(
            &state,
            &flow.login_challenge,
            upstream_error(q.error.as_deref()),
            "GitHub did not authorise the sign-in",
        )
        .await;
    };

    let identity = github::exchange_code(&state.config, &state.http, &code)
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    // The control that makes open client registration survivable: a registered
    // client is useless without a token, and a token issues only to somebody
    // named here.
    if !state.config.login_allowed(&identity.login) {
        tracing::warn!(login = %identity.login, "rejected login: not in GH_ALLOWED");
        return reject(
            &state,
            &flow.login_challenge,
            "access_denied",
            "this account is not permitted to sign in",
        )
        .await;
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

    redirect(&redirect_to, &[cookie::clear_cookie(FLOW_COOKIE)])
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
        return redirect(&redirect_to, &[]);
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
        return continue_to("Denied", &redirect_to);
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
    continue_to("Allowed", &redirect_to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_callback_without_a_flow_says_to_start_again() {
        let response = expired();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&body).contains("sign in again"));
    }

    #[test]
    fn a_decision_continues_by_page_so_form_action_stays_self() {
        let html = ContinueTemplate {
            heading: "Allowed",
            to: "https://claude.ai/api/mcp/auth_callback?code=a&state=b\"><script>",
        }
        .render()
        .unwrap();
        assert!(html.contains(r#"<meta http-equiv="refresh" content="0; url="#));
        assert!(html.contains("code=a&#38;state=b") || html.contains("code=a&amp;state=b"));
        assert!(!html.contains("<script>"));
    }

    /// A header value cannot carry a line break, and Hydra's string reaching
    /// one must be an error response rather than an aborted process.
    #[test]
    fn an_unusable_redirect_target_is_an_error_not_a_panic() {
        assert!(redirect("https://a.example/\r\nSet-Cookie: x=1", &[]).is_err());
        let ok = redirect("https://a.example/cb?code=1", &[]).unwrap();
        assert_eq!(ok.status(), StatusCode::FOUND);
        assert_eq!(
            ok.headers()[header::LOCATION],
            "https://a.example/cb?code=1"
        );
    }

    #[test]
    fn only_a_cancelled_sign_in_reads_as_the_person_refusing() {
        assert_eq!(upstream_error(Some("access_denied")), "access_denied");
        assert_eq!(
            upstream_error(Some("redirect_uri_mismatch")),
            "server_error"
        );
        assert_eq!(upstream_error(None), "server_error");
    }

    #[test]
    fn a_callback_without_a_code_still_parses() {
        let uri: axum::http::Uri = "/cb?error=access_denied&error_description=x&state=s"
            .parse()
            .unwrap();
        let Query(q) = Query::<GithubCallback>::try_from_uri(&uri).unwrap();
        assert!(q.code.is_none());
        assert_eq!(q.error.as_deref(), Some("access_denied"));
        assert_eq!(q.state, "s");
    }
}
