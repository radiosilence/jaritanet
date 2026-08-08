//! Configuration, parsed once at boot and never re-read.
//!
//! Everything arrives as environment variables set by Pulumi, so a missing or
//! malformed value is a deployment that should not start rather than a login
//! that fails halfway through.

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// A client this deployment registered on purpose, as opposed to one that
/// registered itself.
///
/// The distinction is what makes open dynamic registration survivable: a
/// first-party client's id, secret and redirect URIs were decided by the
/// deploy, so granting its request without asking is a decision already made.
/// Anything else gets a consent screen.
#[derive(Clone, Debug, Deserialize)]
pub struct FirstPartyClient {
    pub id: String,
    pub name: String,
    pub secret: String,
    pub redirect_uris: Vec<String>,
    /// Defaulted rather than required: every relying party here wants the same
    /// thing, and a per-client list is a per-client way to get it wrong.
    #[serde(default = "default_scopes")]
    pub scopes: Vec<String>,
}

fn default_scopes() -> Vec<String> {
    ["openid", "profile", "offline_access"]
        .map(str::to_string)
        .to_vec()
}

pub struct Github {
    pub client_id: String,
    pub client_secret: String,
    /// GitHub logins permitted to authenticate at all.
    ///
    /// This is the control that makes open registration safe: a registered
    /// client is useless without a token, and a token issues only to somebody
    /// named here. Empty admits anyone with a GitHub account, which is why
    /// [`Config::from_env`] refuses to start on it.
    pub allowed: Vec<String>,
}

pub struct Config {
    pub bind_addr: String,
    /// Where this is reached from outside. The upstream callback has to match
    /// it exactly, and the pod cannot infer it from a request it has not had.
    pub public_url: String,
    pub redis_url: String,
    /// Hydra's admin API, cluster-internal. It can accept a login for any
    /// subject, so it is never fronted by an IngressRoute.
    pub hydra_admin_url: String,
    pub github: Github,
    pub first_party: Vec<FirstPartyClient>,
}

fn var(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("{key} is not set"))
}

fn var_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let allowed = parse_allowed(&std::env::var("GH_ALLOWED").unwrap_or_default());
        // Refusing to boot rather than warning: an empty allowlist and open
        // registration together mean any GitHub account in the world can get a
        // token for every service behind this. A warning in a log nobody reads
        // is not a control.
        if allowed.is_empty() {
            bail!(
                "GH_ALLOWED is empty: registration is open, so this is the only thing \
                 between a self-registered client and a usable token"
            );
        }

        let first_party =
            parse_first_party(&std::env::var("FIRST_PARTY_CLIENTS").unwrap_or_default())?;

        Ok(Self {
            bind_addr: var_or("BIND_ADDR", "0.0.0.0:8080"),
            public_url: var("PUBLIC_URL")?.trim_end_matches('/').to_string(),
            redis_url: var("REDIS_URL")?,
            hydra_admin_url: var("HYDRA_ADMIN_URL")?.trim_end_matches('/').to_string(),
            github: Github {
                client_id: var("GH_CLIENT_ID")?,
                client_secret: var("GH_CLIENT_SECRET")?,
                allowed,
            },
            first_party,
        })
    }

    pub fn github_redirect_uri(&self) -> String {
        format!("{}/auth/github/callback", self.public_url)
    }

    /// GitHub logins are not case-sensitive, and a deploy that spelled one
    /// differently from the person would lock them out with nothing to read.
    pub fn login_allowed(&self, login: &str) -> bool {
        self.github
            .allowed
            .iter()
            .any(|l| l.eq_ignore_ascii_case(login))
    }

    pub fn first_party(&self, client_id: &str) -> Option<&FirstPartyClient> {
        self.first_party.iter().find(|c| c.id == client_id)
    }
}

fn parse_allowed(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// JSON rather than a bespoke encoding: Pulumi holds this as an array of
/// objects and hands it over with `JSON.stringify`, so there is no format to
/// agree on and no escaping to get wrong in a secret carrying client secrets.
fn parse_first_party(raw: &str) -> Result<Vec<FirstPartyClient>> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let clients: Vec<FirstPartyClient> =
        serde_json::from_str(raw).context("FIRST_PARTY_CLIENTS is not valid JSON")?;
    for client in &clients {
        if client.redirect_uris.is_empty() {
            bail!("first-party client {} declares no redirect_uris", client.id);
        }
    }
    Ok(clients)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(allowed: &[&str], first_party: Vec<FirstPartyClient>) -> Config {
        Config {
            bind_addr: String::new(),
            public_url: "https://auth.example".into(),
            redis_url: String::new(),
            hydra_admin_url: String::new(),
            github: Github {
                client_id: String::new(),
                client_secret: String::new(),
                allowed: allowed.iter().map(|s| s.to_string()).collect(),
            },
            first_party,
        }
    }

    fn client(id: &str) -> FirstPartyClient {
        FirstPartyClient {
            id: id.into(),
            name: id.into(),
            secret: "s".into(),
            redirect_uris: vec!["https://example.test/auth/callback".into()],
            scopes: default_scopes(),
        }
    }

    #[test]
    fn the_allowlist_ignores_case() {
        let c = config(&["RadioSilence"], vec![]);
        assert!(c.login_allowed("radiosilence"));
        assert!(!c.login_allowed("someone-else"));
    }

    /// The whole point of the list: a client that registered itself must never
    /// be mistaken for one this deployment put there.
    #[test]
    fn only_configured_clients_are_first_party() {
        let c = config(&["x"], vec![client("mariastew"), client("mcp-gateway")]);
        assert!(c.first_party("mariastew").is_some());
        assert!(c.first_party("some-dcr-client").is_none());
    }

    #[test]
    fn the_registry_parses_the_shape_pulumi_writes() {
        let parsed = parse_first_party(
            r#"[{"id":"mariastew","name":"mariastew","secret":"hunter2",
                 "redirect_uris":["https://dl.example/auth/callback"]}]"#,
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "mariastew");
        assert!(parsed[0].scopes.contains(&"openid".to_string()));
    }

    /// A client with no redirect URI cannot be sent back to, and registering it
    /// anyway defers the failure to whoever tries to log in.
    #[test]
    fn a_client_with_no_redirect_uri_is_refused() {
        assert!(
            parse_first_party(r#"[{"id":"x","name":"x","secret":"s","redirect_uris":[]}]"#)
                .is_err()
        );
    }

    #[test]
    fn an_absent_registry_is_empty_rather_than_an_error() {
        assert!(parse_first_party("").unwrap().is_empty());
    }
}
