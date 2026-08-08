//! mariastew — paste a magnet on a phone, and later open Infuse and watch it.
//!
//! A small service in front of aria2. aria2 does the downloading and holds all
//! the state; this renders it and takes instructions. Nothing is persisted on
//! this side, so there is no database, no reconciliation, and a restarted pod
//! simply re-reads reality.

mod activity;
mod aria2;
mod auth;
mod config;
mod error;
mod filter;
mod notify;
mod poll;
mod routes;
mod state;
mod views;

use std::sync::Arc;

use axum::Router;
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;

use crate::config::Config;
use crate::state::AppState;

/// `build.rs` finds the one `assets/app-<hash>.js` rolldown wrote and hands
/// its name over as an env var — the hash is how a deploy's new script stops
/// being served from a browser cache still holding the old one, and it is not
/// something the source can spell on its own since rolldown chooses it.
/// `views::Page::app_js_path` renders the same constant into the `<script>`
/// tag that requests it.
pub const APP_JS_PATH: &str = concat!("/assets/", env!("APP_JS_FILENAME"));

/// Served from the binary rather than a volume: the stylesheet and the vendored
/// bundle are build outputs, so a mount would be a second thing to keep in step
/// with the image, and `app.js` travels with them because it is the same thing
/// to the browser.
const ASSETS: [(&str, &str, &str); 3] = [
    (
        APP_JS_PATH,
        "text/javascript; charset=utf-8",
        include_str!(concat!("../assets/", env!("APP_JS_FILENAME"))),
    ),
    (
        "/assets/datastar.js",
        "text/javascript; charset=utf-8",
        include_str!("../assets/datastar.js"),
    ),
    (
        "/assets/app.css",
        "text/css; charset=utf-8",
        include_str!("../assets/app.css"),
    ),
];

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    // The compile-time gate on `/auth/dev-login` (see `auth::routes::router`)
    // means this only fires in a binary that was never meant to be deployed —
    // `cargo build --release` cannot produce one. Loud, at the top of the
    // logs, so a debug binary running anywhere announces it before anything
    // else does.
    #[cfg(debug_assertions)]
    tracing::warn!(
        "DEBUG BUILD: /auth/dev-login is compiled in and skips sign-in entirely — this build must never run in production"
    );

    let config = Config::from_env()?;
    let bind_addr = config.bind_addr.clone();
    let http = reqwest::Client::builder().build()?;

    let state = AppState {
        aria2: aria2::Aria2::new(config.aria2_rpc_url.clone(), http.clone()),
        config: Arc::new(config),
        sessions: auth::session::Sessions::new(),
        activity: activity::Activity::new(),
        poll: poll::Poll::new(),
        clearing: state::Clearing::default(),
        http,
    };

    // The poller before the watcher: the watcher reads its snapshots and would
    // otherwise sit on an empty channel until the first tick anyway.
    poll::spawn(state.clone());
    notify::spawn_watcher(state.clone());

    // Only what is genuinely public sits outside the auth layer: the probe the
    // kubelet calls, the login round-trip that cannot require a session to
    // establish one, and the static assets. Everything else is inside
    // `routes::router`, which the layer wraps whole.
    let mut app = Router::new()
        .merge(routes::router().layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::extract::require_session,
        )))
        .merge(auth::routes::router())
        .route("/healthz", get(|| async { "ok" }));
    for (path, content_type, body) in ASSETS {
        app =
            app.route(
                path,
                get(move || async move {
                    ([(header::CONTENT_TYPE, content_type)], body).into_response()
                }),
            );
    }
    let app = app
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!(%bind_addr, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

/// A pod being replaced gets its in-flight requests finished. The streams are
/// long-lived by design, so this does not wait for them — the client reconnects
/// to the new pod, which is the same thing that happens on any restart.
async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
