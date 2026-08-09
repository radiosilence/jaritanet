//! The upstream identity provider, and the only thing here that knows there is
//! one.
//!
//! No relying party learns which upstream vouched for a person, and none of
//! them has to change when that answer does — which is the point of the whole
//! service, and the reason this module is the only place GitHub appears.

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use url::Url;

use crate::config::Config;

/// Who GitHub says this is: a stable numeric id, the login to show, and an
/// address to reach them at.
///
/// The subject is the id rather than the login because a login can be changed
/// by its owner and reused by somebody else, and every relying party keys its
/// own state on whatever is issued here.
///
/// The address is not decoration. Grafana refuses a login carrying no `email`
/// claim outright — `errOAuthMissingRequiredEmail`, before its own user sync
/// runs — so a provider that emits none cannot sign anyone in to it at all.
pub struct Identity {
    pub subject: String,
    pub login: String,
    pub email: String,
    /// Whether GitHub vouches for the address, which is false for the fallback
    /// below. Nothing here reads it; it goes on the token because a relying
    /// party deciding that a verified address is proof of anything deserves to
    /// be told when it is not one.
    pub email_verified: bool,
}

/// `user:email` is the narrowest scope that answers "what is this person's
/// address": `read:user` returns the profile's *public* email, which is null
/// unless they chose to publish one, so relying on it works for whoever set it
/// up and fails silently for everyone else.
const SCOPE: &str = "read:user user:email";

pub fn authorize_url(config: &Config, csrf: &str) -> String {
    let mut url = Url::parse("https://github.com/login/oauth/authorize").expect("static URL");
    url.query_pairs_mut()
        .append_pair("client_id", &config.github.client_id)
        .append_pair("redirect_uri", &config.github_redirect_uri())
        .append_pair("scope", SCOPE)
        .append_pair("state", csrf);
    url.into()
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct User {
    id: u64,
    login: String,
}

#[derive(Deserialize)]
struct Address {
    email: String,
    primary: bool,
    verified: bool,
}

/// GitHub's own no-reply address for an account.
///
/// Used when the address list cannot be read or holds nothing verified. It is
/// not a placeholder: GitHub routes it, it is unique to this account, and it
/// survives a login being renamed because the numeric id leads. That matters
/// because a relying party keys a user on whatever arrives here, so an address
/// that changes shape later is a duplicate account rather than an update.
fn noreply(user: &User) -> String {
    format!("{}+{}@users.noreply.github.com", user.id, user.login)
}

/// The primary verified address, or any verified one.
///
/// Verified only, deliberately. An unverified address on GitHub is a string
/// somebody typed, and handing it downstream as an identity claim is how an
/// account gets matched to a mailbox its owner never proved they hold.
fn pick(addresses: &[Address]) -> Option<&Address> {
    addresses
        .iter()
        .find(|a| a.primary && a.verified)
        .or_else(|| addresses.iter().find(|a| a.verified))
}

pub async fn exchange_code(
    config: &Config,
    http: &reqwest::Client,
    code: &str,
) -> Result<Identity> {
    let response = http
        .post("https://github.com/login/oauth/access_token")
        .header("accept", "application/json")
        .form(&[
            ("client_id", config.github.client_id.as_str()),
            ("client_secret", config.github.client_secret.as_str()),
            ("code", code),
            ("redirect_uri", &config.github_redirect_uri()),
        ])
        .send()
        .await
        .context("calling GitHub's token endpoint")?
        .error_for_status()
        .context("GitHub's token endpoint rejected the exchange")?;

    let token: TokenResponse = response
        .json()
        .await
        .context("GitHub's token response was not JSON")?;

    // GitHub answers a refused exchange with 200 and an error body, so the
    // status alone is not the verdict.
    let Some(access_token) = token.access_token else {
        bail!(
            "GitHub refused the code: {}",
            token
                .error_description
                .as_deref()
                .unwrap_or("no reason given")
        );
    };

    let user: User = http
        .get("https://api.github.com/user")
        .header("accept", "application/vnd.github+json")
        // GitHub rejects an API request with no user agent outright.
        .header("user-agent", "jaritanet-auth")
        .bearer_auth(&access_token)
        .send()
        .await
        .context("calling GitHub's user endpoint")?
        .error_for_status()
        .context("GitHub refused to identify the token holder")?
        .json()
        .await
        .context("GitHub's user response was not JSON")?;

    // A failure here is not a failed login: the fallback address is derivable
    // from what is already in hand, and refusing to sign anyone in because
    // GitHub's address list was briefly unavailable trades an inconvenience
    // for an outage.
    let addresses: Vec<Address> = match http
        .get("https://api.github.com/user/emails")
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "jaritanet-auth")
        .bearer_auth(&access_token)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
    {
        Ok(response) => response.json().await.unwrap_or_default(),
        Err(err) => {
            tracing::warn!(%err, "GitHub refused the address list; using the no-reply address");
            Vec::new()
        }
    };

    let (email, email_verified) = match pick(&addresses) {
        Some(address) => (address.email.clone(), true),
        None => (noreply(&user), false),
    };

    Ok(Identity {
        subject: format!("github:{}", user.id),
        login: user.login,
        email,
        email_verified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, Github};

    fn config() -> Config {
        Config {
            bind_addr: String::new(),
            public_url: "https://auth.example".into(),
            redis_url: String::new(),
            hydra_admin_url: String::new(),
            github: Github {
                client_id: "cid".into(),
                client_secret: String::new(),
                allowed: vec!["someone".into()],
            },
            first_party: vec![],
        }
    }

    #[test]
    fn the_authorize_url_carries_the_callback_and_the_csrf() {
        let url = authorize_url(&config(), "nonce");
        assert!(url.starts_with("https://github.com/login/oauth/authorize?"));
        assert!(url.contains("client_id=cid"));
        assert!(url.contains("state=nonce"));
        assert!(url.contains("auth%2Fgithub%2Fcallback"));
    }

    /// Narrowing this breaks every login at once and reads, downstream, as the
    /// provider refusing the request rather than as a missing claim.
    #[test]
    fn the_authorize_url_asks_for_the_address() {
        assert!(authorize_url(&config(), "nonce").contains("user%3Aemail"));
    }

    fn address(email: &str, primary: bool, verified: bool) -> Address {
        Address {
            email: email.into(),
            primary,
            verified,
        }
    }

    #[test]
    fn the_primary_verified_address_wins() {
        let addresses = [
            address("old@example.com", false, true),
            address("jc@blit.cc", true, true),
        ];
        assert_eq!(
            pick(&addresses).map(|a| a.email.as_str()),
            Some("jc@blit.cc")
        );
    }

    /// An unverified address is a string somebody typed. Handing it downstream
    /// as an identity claim is how an account is matched to a mailbox its owner
    /// never proved they hold — so it loses to a verified non-primary, and to
    /// nothing at all.
    #[test]
    fn an_unverified_address_never_wins() {
        let addresses = [
            address("unproven@example.com", true, false),
            address("old@example.com", false, true),
        ];
        assert_eq!(
            pick(&addresses).map(|a| a.email.as_str()),
            Some("old@example.com")
        );
        assert!(pick(&[address("unproven@example.com", true, false)]).is_none());
        assert!(pick(&[]).is_none());
    }

    /// The fallback leads with the numeric id, so it survives the login being
    /// renamed. A relying party keys a user on whatever arrives here, and an
    /// address that changes shape later is a duplicate account, not an update.
    #[test]
    fn the_fallback_address_is_githubs_own() {
        let user = User {
            id: 12345,
            login: "radiosilence".into(),
        };
        assert_eq!(
            noreply(&user),
            "12345+radiosilence@users.noreply.github.com"
        );
    }

    /// The callback path is what the OAuth App is registered with, so it is
    /// worth a test that fails loudly rather than at a browser mid-login.
    #[test]
    fn the_callback_sits_under_the_auth_prefix() {
        assert_eq!(
            config().github_redirect_uri(),
            "https://auth.example/auth/github/callback"
        );
    }
}
