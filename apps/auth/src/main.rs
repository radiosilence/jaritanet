//! One login screen, independent of the applications it signs you into.
//!
//! Hydra drives the OAuth and OIDC protocol and delegates two questions back:
//! who is this person, and do they consent. This answers both. It issues no
//! tokens, stores no accounts, and never learns what a relying party does with
//! the subject it hands out.
//!
//! It exists separately because Hydra takes one login provider for the whole
//! authorization server. When the first service to need OAuth also implements
//! that provider, every service after it inherits a dependency on an unrelated
//! application being healthy — which is exactly how a degraded MCP gateway
//! became intermittent login failures on the torrent UI.

mod config;
mod cookie;
mod error;
mod github;
mod hydra;
mod register;
mod routes;
mod state;
mod store;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::Router;
use axum::http::{HeaderValue, header};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::json;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::hydra::HydraAdmin;
use crate::state::AppState;
use crate::store::Store;

/// Baked into the binary rather than served from a volume: this stylesheet is
/// fetched mid-authentication, so the deployment is one artefact with nothing
/// else to mount and nothing to go stale against the templates it styles.
const APP_CSS: &str = include_str!("../assets/app.css");

/// No script anywhere. A login provider is the last page that should be
/// executing anything it did not have to, and the consent screen is a form.
const CSP: &str = "default-src 'self'; \
     script-src 'none'; \
     style-src 'self'; \
     img-src 'self' data:; \
     connect-src 'self'; \
     form-action 'self'; \
     frame-ancestors 'none'; \
     base-uri 'none'; \
     object-src 'none'";

async fn security_headers(request: axum::extract::Request, next: middleware::Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

async fn app_css() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], APP_CSS)
}

/// Register every client this deployment owns, so a relying party's
/// registration is part of the deploy rather than an admin call somebody has to
/// remember after a rebuild.
///
/// Deliberately not Hydra's own `skip_consent`, even though these are granted
/// without being asked about. That flag bypasses the consent endpoint entirely,
/// and the consent endpoint is where the identity claims are attached — turning
/// it on would silently return every relying party to a token carrying a bare
/// subject. The auto-grant lives in the handler for exactly that reason.
async fn ensure_first_party(config: &Config, hydra: &HydraAdmin) -> Result<()> {
    for client in &config.first_party {
        hydra
            .ensure_client(
                &client.id,
                &json!({
                    "client_id": client.id,
                    "client_name": client.name,
                    "client_secret": client.secret,
                    "redirect_uris": client.redirect_uris,
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "scope": client.scopes.join(" "),
                    "token_endpoint_auth_method": "client_secret_post",
                }),
            )
            .await
            .with_context(|| format!("registering first-party client {}", client.id))?;
        tracing::info!(client = %client.id, "first-party client registered");
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "auth=info,tower_http=info,warn".into()),
        )
        .init();

    let config = Config::from_env()?;
    let bind_addr = config.bind_addr.clone();

    let store = Store::connect(&config.redis_url).await?;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("building the HTTP client")?;
    let hydra = HydraAdmin::new(&config.hydra_admin_url, http.clone());

    ensure_first_party(&config, &hydra).await?;

    let state = AppState {
        config: Arc::new(config),
        store,
        http,
        hydra,
    };

    let app = Router::new()
        .route("/", get(routes::index))
        .route("/healthz", get(|| async { "ok" }))
        .route("/assets/app.css", get(app_css))
        .route("/auth/login", get(routes::login))
        .route("/auth/github/callback", get(routes::github_callback))
        .route(
            "/auth/consent",
            get(routes::consent).post(routes::consent_decision),
        )
        .route("/register", post(register::register))
        .layer(middleware::from_fn(security_headers))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("binding {bind_addr}"))?;
    tracing::info!("listening on http://{bind_addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .context("serving")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use tower::ServiceExt as _;

    #[tokio::test]
    async fn every_response_carries_the_security_headers() {
        let app = Router::new()
            .route("/", get(|| async { "hi" }))
            .layer(middleware::from_fn(security_headers));

        let response = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        let headers = response.headers();
        let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("frame-ancestors 'none'"));
        // A login provider executing script it did not need is the whole class
        // of bug this closes, and no page here wants any.
        assert!(csp.contains("script-src 'none'"));
        assert!(
            !csp.contains("unsafe-inline"),
            "the CSP has an inline hatch"
        );
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY");
        assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
    }
}
