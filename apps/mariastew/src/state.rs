//! Shared state, cloned into every handler. Every field is cheap to clone —
//! an `Arc`, a `reqwest::Client`, or a map behind one.

use std::sync::Arc;

use crate::aria2::Aria2;
use crate::auth::session::Sessions;
use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub aria2: Aria2,
    pub sessions: Sessions,
    /// Hydra and Telegram. One client, so the connection pool and the TLS
    /// session cache are shared.
    pub http: reqwest::Client,
}
