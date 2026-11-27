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
mod web;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::json;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::hydra::HydraAdmin;
use crate::state::AppState;
use crate::store::Store;

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

/// How long the listener stays open after SIGTERM. Traefik keeps routing to a
/// terminating pod until the endpoint removal reaches it, and a request landing
/// on a closed listener in that window becomes a 502 mid-login.
const DRAIN: Duration = Duration::from_secs(5);

/// Resolves `DRAIN` after SIGTERM, or at once on ctrl-c. As PID 1 in a scratch
/// image nothing installs a default handler, so without this the kubelet's
/// SIGTERM is ignored and every rollout waits out the grace period before a
/// SIGKILL.
async fn shutdown_signal(mut term: tokio::signal::unix::Signal) {
    tokio::select! {
        _ = term.recv() => {
            tracing::info!("SIGTERM, draining for {DRAIN:?}");
            tokio::time::sleep(DRAIN).await;
        }
        _ = tokio::signal::ctrl_c() => {}
    }
    tracing::info!("shutting down");
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

    // The only TLS this client speaks is to GitHub, so it trusts only the roots
    // GitHub chains to rather than a system bundle: a compromised intermediate
    // under any other CA cannot impersonate GitHub to the login flow. GitHub
    // changing CA fails every login until roots.pem is replaced.
    let roots = reqwest::Certificate::from_pem_bundle(include_bytes!("../roots.pem"))
        .context("parsing roots.pem")?;
    let http = reqwest::Client::builder()
        .tls_certs_only(roots)
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

    let app = web::router(state);

    let term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("installing a SIGTERM handler")?;
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("binding {bind_addr}"))?;
    tracing::info!("listening on http://{bind_addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(term))
    .await
    .context("serving")?;
    Ok(())
}
