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

/// Who GitHub says this is: a stable numeric id, and the login to show.
///
/// The subject is the id rather than the login because a login can be changed
/// by its owner and reused by somebody else, and every relying party keys its
/// own state on whatever is issued here.
pub struct Identity {
    pub subject: String,
    pub login: String,
}

pub fn authorize_url(config: &Config, csrf: &str) -> String {
    let mut url = Url::parse("https://github.com/login/oauth/authorize").expect("static URL");
    url.query_pairs_mut()
        .append_pair("client_id", &config.github.client_id)
        .append_pair("redirect_uri", &config.github_redirect_uri())
        .append_pair("scope", "read:user")
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

    Ok(Identity {
        subject: format!("github:{}", user.id),
        login: user.login,
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
