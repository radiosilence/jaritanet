//! Shared state, cloned into every handler. Every field is cheap to clone —
//! an `Arc`, a `reqwest::Client`, or a map behind one.

use std::sync::Arc;

use crate::activity::Activity;
use crate::aria2::Aria2;
use crate::auth::session::Sessions;
use crate::config::Config;
use crate::poll::Poll;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub aria2: Aria2,
    pub sessions: Sessions,
    /// The single poll of aria2 every page and the notifier read from, rather
    /// than each running its own.
    pub poll: Poll,
    /// What happened to each download, for the part of it aria2 does not know
    /// — see `activity`.
    pub activity: Activity,
    /// Hydra and Telegram. One client, so the connection pool and the TLS
    /// session cache are shared.
    pub http: reqwest::Client,
}
