//! Server-side sessions and login flows, keyed by opaque ids.
//!
//! Cookies carry an id and nothing else — no JWT, nothing forgeable, nothing
//! claim-bearing on the client. The store is a map behind a lock because there
//! is one pod and no database; that is the whole design, and it is why a
//! restart signs everyone out.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng as _;
use tokio::sync::RwLock;

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    /// Hydra's subject. Not shown anywhere; it is what makes a session an
    /// identity rather than a bare permit.
    pub sub: String,
    pub expires: Instant,
}

/// A login round-trip in progress: the PKCE verifier and the CSRF state, held
/// server-side so neither travels through the browser.
#[derive(Clone, Debug)]
pub struct Flow {
    pub verifier: String,
    pub csrf: String,
    pub expires: Instant,
}

#[derive(Clone, Default)]
pub struct Sessions {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    flows: Arc<RwLock<HashMap<String, Flow>>>,
}

impl Sessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// A URL-safe opaque id with 128 bits behind it.
    pub fn token() -> String {
        let mut bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    }

    pub async fn create(&self, sub: &str, ttl: Duration) -> String {
        let id = Self::token();
        let session = Session {
            id: id.clone(),
            sub: sub.to_string(),
            expires: Instant::now() + ttl,
        };
        self.sessions.write().await.insert(id.clone(), session);
        id
    }

    /// `None` for an unknown or expired id. Expiry is checked on read rather
    /// than swept on a timer: the map is small, and a sweeper is a task to keep
    /// alive for no benefit at this size.
    pub async fn get(&self, id: &str) -> Option<Session> {
        let mut sessions = self.sessions.write().await;
        match sessions.get(id) {
            Some(session) if Instant::now() < session.expires => Some(session.clone()),
            Some(_) => {
                sessions.remove(id);
                None
            }
            None => None,
        }
    }

    pub async fn delete(&self, id: &str) {
        self.sessions.write().await.remove(id);
    }

    pub async fn begin_flow(&self, verifier: &str, csrf: &str, ttl: Duration) -> String {
        let id = Self::token();
        let flow = Flow {
            verifier: verifier.to_string(),
            csrf: csrf.to_string(),
            expires: Instant::now() + ttl,
        };
        self.flows.write().await.insert(id.clone(), flow);
        id
    }

    /// One-shot: taking a flow consumes it, so a callback cannot be replayed.
    pub async fn take_flow(&self, id: &str) -> Option<Flow> {
        let flow = self.flows.write().await.remove(id)?;
        (Instant::now() < flow.expires).then_some(flow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_created_session_is_retrievable_by_its_id() {
        let sessions = Sessions::new();
        let id = sessions.create("alice", Duration::from_secs(60)).await;
        let session = sessions.get(&id).await.expect("session should exist");
        assert_eq!(session.sub, "alice");
    }

    #[tokio::test]
    async fn an_unknown_id_is_none() {
        let sessions = Sessions::new();
        assert!(sessions.get("nope").await.is_none());
    }

    #[tokio::test]
    async fn a_session_with_a_near_zero_ttl_is_none_on_read() {
        let sessions = Sessions::new();
        let id = sessions.create("alice", Duration::from_millis(1)).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(sessions.get(&id).await.is_none());
    }

    #[tokio::test]
    async fn take_flow_returns_once_then_none() {
        let sessions = Sessions::new();
        let id = sessions
            .begin_flow("verifier", "csrf", Duration::from_secs(60))
            .await;
        assert!(sessions.take_flow(&id).await.is_some());
        assert!(sessions.take_flow(&id).await.is_none());
    }

    #[test]
    fn two_tokens_differ() {
        assert_ne!(Sessions::token(), Sessions::token());
    }
}
