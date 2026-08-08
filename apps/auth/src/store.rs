//! The only state this service holds: an in-flight login, for ten minutes.
//!
//! A row is a CSRF value and the Hydra login challenge it was started for, held
//! across the redirect to GitHub and consumed when the browser comes back.
//! There is nothing else — registered clients, consent grants and tokens are
//! Hydra's, and what a relying party knows about a person is that relying
//! party's, keyed on the subject issued here.
//!
//! Redis rather than a database because that is the whole shape of the problem:
//! one key, written once, read once, expiring on its own. `SET .. EX` and
//! `GETDEL` are those two operations exactly, which is why there is no schema,
//! no migration at boot, and no sweeper for rows a login walked away from.

use anyhow::{Context, Result};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng as _;
use redis::AsyncCommands as _;
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};

/// Long enough to sign in to GitHub from a cold session, short enough that an
/// abandoned flow is not a credential lying around.
pub const FLOW_TTL_SECS: u64 = 600;

const PREFIX: &str = "flow:";

/// Transient login-flow state carried across the redirect to GitHub.
#[derive(Serialize, Deserialize)]
pub struct Flow {
    pub csrf: String,
    pub login_challenge: String,
}

/// 256 bits from the OS, URL-safe. This value is the only thing tying a
/// callback to the flow that started it, so it is a credential.
fn new_id() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Clone)]
pub struct Store {
    conn: ConnectionManager,
}

impl Store {
    /// `ConnectionManager` reconnects on its own, so a Redis restart costs the
    /// logins in flight at that moment rather than every login until this pod
    /// is restarted too.
    pub async fn connect(redis_url: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url).context("REDIS_URL is not a Redis URL")?;
        let conn = ConnectionManager::new(client)
            .await
            .context("connecting to Redis")?;
        Ok(Self { conn })
    }

    pub async fn create_flow(&self, flow: &Flow) -> Result<String> {
        let id = new_id();
        let body = serde_json::to_string(flow)?;
        let mut conn = self.conn.clone();
        let _: () = conn
            .set_ex(format!("{PREFIX}{id}"), body, FLOW_TTL_SECS)
            .await
            .context("writing the login flow")?;
        Ok(id)
    }

    /// Read and delete in one command, so a replayed callback finds nothing
    /// rather than a second usable flow.
    pub async fn take_flow(&self, id: &str) -> Result<Option<Flow>> {
        let mut conn = self.conn.clone();
        let body: Option<String> = conn
            .get_del(format!("{PREFIX}{id}"))
            .await
            .context("reading the login flow")?;
        Ok(body.as_deref().and_then(|b| serde_json::from_str(b).ok()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unguessable_and_distinct() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        // 32 bytes, base64 unpadded.
        assert_eq!(a.len(), 43);
    }

    #[test]
    fn a_flow_round_trips_through_its_stored_form() {
        let flow = Flow {
            csrf: "csrf-value".into(),
            login_challenge: "challenge-value".into(),
        };
        let encoded = serde_json::to_string(&flow).unwrap();
        let decoded: Flow = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.csrf, "csrf-value");
        assert_eq!(decoded.login_challenge, "challenge-value");
    }
}
