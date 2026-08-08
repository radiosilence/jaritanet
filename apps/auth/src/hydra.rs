//! Hydra's admin API — the back channel this service answers challenges on.
//!
//! Never fronted by an IngressRoute. It accepts a login for any subject without
//! authenticating the caller, so reaching it is equivalent to being anyone.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{Value, json};

/// How long Hydra remembers that this person is signed in.
///
/// This is the session that makes the second service seamless, and it lives at
/// the authorization server rather than here — which is why this service keeps
/// no session of its own, and why restarting it logs nobody out.
const REMEMBER_FOR_SECS: u64 = 30 * 24 * 3600;

#[derive(Deserialize)]
pub struct Client {
    pub client_id: String,
    #[serde(default)]
    pub client_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    /// Hydra already has a session for this person: it is asking whether that
    /// still stands, not for them to be authenticated again.
    #[serde(default)]
    pub skip: bool,
    #[serde(default)]
    pub subject: String,
    /// Whatever was attached when this session was accepted. Carries the
    /// upstream login, so a skipped login still knows whose name to put on the
    /// token without asking GitHub again.
    #[serde(default)]
    pub context: Value,
}

#[derive(Deserialize)]
pub struct ConsentRequest {
    pub client: Client,
    pub subject: String,
    #[serde(default)]
    pub requested_scope: Vec<String>,
    #[serde(default)]
    pub requested_access_token_audience: Vec<String>,
    #[serde(default)]
    pub context: Value,
}

impl ConsentRequest {
    /// The name to show, falling back to the id. A self-registered client
    /// chooses its own `client_name`, so this string is attacker-controlled and
    /// is only ever rendered through the template's escaping.
    pub fn client_label(&self) -> &str {
        self.client
            .client_name
            .as_deref()
            .filter(|n| !n.is_empty())
            .unwrap_or(&self.client.client_id)
    }

    pub fn login(&self) -> &str {
        self.context
            .get("login")
            .and_then(Value::as_str)
            .unwrap_or(&self.subject)
    }
}

#[derive(Deserialize)]
struct Redirect {
    redirect_to: String,
}

#[derive(Clone)]
pub struct HydraAdmin {
    base: String,
    http: reqwest::Client,
}

impl HydraAdmin {
    pub fn new(base: &str, http: reqwest::Client) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            http,
        }
    }

    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T> {
        self.http
            .get(format!("{}{path}", self.base))
            .query(query)
            .send()
            .await
            .with_context(|| format!("calling Hydra {path}"))?
            .error_for_status()
            .with_context(|| format!("Hydra refused {path}"))?
            .json()
            .await
            .with_context(|| format!("Hydra's {path} response was not JSON"))
    }

    async fn put_redirect(
        &self,
        path: &str,
        query: &[(&str, &str)],
        body: &Value,
    ) -> Result<String> {
        let redirect: Redirect = self
            .http
            .put(format!("{}{path}", self.base))
            .query(query)
            .json(body)
            .send()
            .await
            .with_context(|| format!("calling Hydra {path}"))?
            .error_for_status()
            .with_context(|| format!("Hydra refused {path}"))?
            .json()
            .await
            .with_context(|| format!("Hydra's {path} response was not JSON"))?;
        Ok(redirect.redirect_to)
    }

    pub async fn get_login(&self, challenge: &str) -> Result<LoginRequest> {
        self.get(
            "/admin/oauth2/auth/requests/login",
            &[("login_challenge", challenge)],
        )
        .await
    }

    /// Accept the login, and attach the upstream login name to the session.
    ///
    /// The `context` is what a later skipped login and every consent request
    /// read back, so the name survives without GitHub being asked a second
    /// time — and without this service keeping a session to hold it in.
    pub async fn accept_login(
        &self,
        challenge: &str,
        subject: &str,
        login: &str,
    ) -> Result<String> {
        self.put_redirect(
            "/admin/oauth2/auth/requests/login/accept",
            &[("login_challenge", challenge)],
            &json!({
                "subject": subject,
                "remember": true,
                "remember_for": REMEMBER_FOR_SECS,
                "context": { "login": login },
            }),
        )
        .await
    }

    pub async fn get_consent(&self, challenge: &str) -> Result<ConsentRequest> {
        self.get(
            "/admin/oauth2/auth/requests/consent",
            &[("consent_challenge", challenge)],
        )
        .await
    }

    /// Grant exactly what was asked for, and put a name on the token.
    ///
    /// A login accepted without session claims yields an ID token carrying
    /// `sub` and nothing else, which leaves every dashboard downstream
    /// displaying `github:12345` at its user. The name comes from here or it
    /// does not exist.
    pub async fn accept_consent(&self, challenge: &str, req: &ConsentRequest) -> Result<String> {
        let login = req.login();
        self.put_redirect(
            "/admin/oauth2/auth/requests/consent/accept",
            &[("consent_challenge", challenge)],
            &json!({
                "grant_scope": req.requested_scope,
                "grant_access_token_audience": req.requested_access_token_audience,
                "remember": true,
                "remember_for": REMEMBER_FOR_SECS,
                "session": {
                    "id_token": {
                        "name": login,
                        "preferred_username": login,
                    },
                },
            }),
        )
        .await
    }

    pub async fn reject_consent(&self, challenge: &str) -> Result<String> {
        self.put_redirect(
            "/admin/oauth2/auth/requests/consent/reject",
            &[("consent_challenge", challenge)],
            &json!({ "error": "access_denied", "error_description": "the user refused" }),
        )
        .await
    }

    /// Create the client, or update it if it is already there.
    ///
    /// PUT first because the common case is a redeploy of a client that exists;
    /// Hydra answers 404 for one it has never seen, which is the only signal
    /// that a POST is the right verb.
    pub async fn ensure_client(&self, id: &str, body: &Value) -> Result<()> {
        let response = self
            .http
            .put(format!("{}/admin/clients/{id}", self.base))
            .json(body)
            .send()
            .await
            .context("calling Hydra to update a client")?;

        if response.status() != reqwest::StatusCode::NOT_FOUND {
            response
                .error_for_status()
                .with_context(|| format!("Hydra refused to update client {id}"))?;
            return Ok(());
        }

        self.http
            .post(format!("{}/admin/clients", self.base))
            .json(body)
            .send()
            .await
            .context("calling Hydra to create a client")?
            .error_for_status()
            .with_context(|| format!("Hydra refused to create client {id}"))?;
        Ok(())
    }

    pub async fn create_client(&self, body: &Value) -> Result<Value> {
        self.http
            .post(format!("{}/admin/clients", self.base))
            .json(body)
            .send()
            .await
            .context("calling Hydra to register a client")?
            .error_for_status()
            .context("Hydra refused the registration")?
            .json()
            .await
            .context("Hydra's registration response was not JSON")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consent(name: Option<&str>, context: Value) -> ConsentRequest {
        ConsentRequest {
            client: Client {
                client_id: "some-id".into(),
                client_name: name.map(str::to_string),
            },
            subject: "github:12345".into(),
            requested_scope: vec!["openid".into()],
            requested_access_token_audience: vec![],
            context,
        }
    }

    #[test]
    fn a_client_with_no_name_is_shown_by_id() {
        assert_eq!(consent(None, Value::Null).client_label(), "some-id");
        assert_eq!(consent(Some(""), Value::Null).client_label(), "some-id");
        assert_eq!(
            consent(Some("Claude"), Value::Null).client_label(),
            "Claude"
        );
    }

    /// The login rides in the session context so a skipped login still knows
    /// it; without one there is only the subject, which is what the claim
    /// exists to avoid showing.
    #[test]
    fn the_login_comes_from_the_session_context() {
        assert_eq!(
            consent(None, json!({ "login": "radiosilence" })).login(),
            "radiosilence"
        );
        assert_eq!(consent(None, Value::Null).login(), "github:12345");
    }
}
