//! Shared state, cloned into every handler. Every field is cheap to clone —
//! an `Arc`, a `reqwest::Client`, or a map behind one.

use std::sync::Arc;

use crate::activity::Activity;
use crate::aria2::Aria2;
use crate::auth::session::Sessions;
use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub aria2: Aria2,
    pub sessions: Sessions,
    /// What happened to each download, for the part of it aria2 does not know
    /// — see `activity`.
    pub activity: Activity,
    /// Hydra and Telegram. One client, so the connection pool and the TLS
    /// session cache are shared.
    pub http: reqwest::Client,
}
