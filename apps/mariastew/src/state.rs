//! Shared state, cloned into every handler. Every field is cheap to clone —
//! an `Arc`, a `reqwest::Client`, or a map behind one.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use crate::activity::Activity;
use crate::aria2::Aria2;
use crate::auth::session::Sessions;
use crate::config::Config;
use crate::poll::Poll;

/// Downloads whose removal has been asked for and that aria2 has not yet let
/// go of.
///
/// aria2 does not forget a download the moment it is told to, and the list is
/// redrawn from aria2 once a second — so a press had no effect anything could
/// see until the row eventually vanished, which is what made the button read
/// as broken. A gid in here renders as "clearing" with its controls replaced
/// by a spinner, from every render of every open page rather than only the one
/// that was clicked: the state belongs to the download, not to the browser
/// that asked.
#[derive(Clone, Default)]
pub struct Clearing(Arc<Mutex<HashSet<String>>>);

impl Clearing {
    /// A poisoned lock is recovered from rather than propagated, for the same
    /// reason `Activity` does it: losing this set would leave every row that
    /// was mid-removal stuck showing controls that do nothing.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `true` when this call is the one that marked it. A second press while
    /// the first removal is still in flight is not a second removal.
    pub fn begin(&self, gid: &str) -> bool {
        self.lock().insert(gid.to_string())
    }

    pub fn end(&self, gid: &str) {
        self.lock().remove(gid);
    }

    pub fn contains(&self, gid: &str) -> bool {
        self.lock().contains(gid)
    }
}

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
    /// Removals in flight — see [`Clearing`].
    pub clearing: Clearing,
    /// Hydra and Telegram. One client, so the connection pool and the TLS
    /// session cache are shared.
    pub http: reqwest::Client,
}
