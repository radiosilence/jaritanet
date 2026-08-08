//! mariastew — paste a magnet on a phone, and later open Infuse and watch it.
//!
//! A small service in front of aria2. aria2 does the downloading and holds all
//! the state; this renders it and takes instructions. Nothing is persisted on
//! this side, so there is no database and a restarted pod simply re-reads
//! reality — except for the one thing aria2 cannot restore on its own, an add
//! that was still in flight when the pod went away (see `resume`).

mod activity;
mod aria2;
mod auth;
mod config;
mod error;
mod filter;
mod notify;
mod poll;
mod resume;
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
///
/// Bodies are bytes rather than `&str` because half of these are now PNGs.
/// `include_bytes!` covers the text ones too — the content type is stated here
/// either way, so nothing was being checked by the compiler's insistence that
/// the script was UTF-8.
///
/// `/favicon.ico` sits beside its `/assets` copy because that is the path a
/// browser asks for on its own, before it has parsed any `<link>` — and the
/// only router that would otherwise answer it is behind the session layer, so
/// an unauthenticated tab would get a login redirect where it wanted an image.
const ASSETS: [(&str, &str, &[u8]); 12] = [
    (
        APP_JS_PATH,
        "text/javascript; charset=utf-8",
        include_bytes!(concat!("../assets/", env!("APP_JS_FILENAME"))),
    ),
    (
        "/assets/datastar.js",
        "text/javascript; charset=utf-8",
        include_bytes!("../assets/datastar.js"),
    ),
    (
        "/assets/app.css",
        "text/css; charset=utf-8",
        include_bytes!("../assets/app.css"),
    ),
    (
        "/assets/manifest.webmanifest",
        "application/manifest+json",
        include_bytes!("../assets/manifest.webmanifest"),
    ),
    (
        "/assets/icon.svg",
        "image/svg+xml",
        include_bytes!("../assets/icon.svg"),
    ),
    (
        "/assets/favicon.ico",
        "image/x-icon",
        include_bytes!("../assets/favicon.ico"),
    ),
    (
        "/favicon.ico",
        "image/x-icon",
        include_bytes!("../assets/favicon.ico"),
    ),
    (
        "/assets/apple-touch-icon.png",
        "image/png",
        include_bytes!("../assets/apple-touch-icon.png"),
    ),
    (
        "/assets/icon-192.png",
        "image/png",
        include_bytes!("../assets/icon-192.png"),
    ),
    (
        "/assets/icon-512.png",
        "image/png",
        include_bytes!("../assets/icon-512.png"),
    ),
    (
        "/assets/icon-192-maskable.png",
        "image/png",
        include_bytes!("../assets/icon-192-maskable.png"),
    ),
    (
        "/assets/icon-512-maskable.png",
        "image/png",
        include_bytes!("../assets/icon-512-maskable.png"),
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
        adding: state::Adding::default(),
        http,
    };

    // The poller before the watcher: the watcher reads its snapshots and would
    // otherwise sit on an empty channel until the first tick anyway. `resume`
    // reads the same channel, and only its first snapshot.
    poll::spawn(state.clone());
    notify::spawn_watcher(state.clone());
    resume::spawn(state.clone());

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
