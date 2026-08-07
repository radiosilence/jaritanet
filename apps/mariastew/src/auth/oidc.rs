//! The authorization-code exchange against Hydra.
//!
//! PKCE is used even though this client holds a secret. It costs one hash and
//! removes the class of attack where a leaked authorization code is enough on
//! its own.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng as _;
use sha2::{Digest, Sha256};
use url::Url;

use crate::config::Oidc;
use crate::error::{AppError, AppResult};

/// The authorization endpoint URL to send the browser to.
pub fn authorize_url(oidc: &Oidc, redirect_uri: &str, csrf: &str, challenge: &str) -> String {
    let mut url = Url::parse(&format!("{}/oauth2/auth", oidc.issuer)).expect("issuer is a URL");
    url.query_pairs_mut()
        .append_pair("client_id", &oidc.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid offline_access")
        .append_pair("state", csrf)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    url.into()
}

/// A fresh PKCE verifier and its S256 challenge.
///
/// Used even though this client holds a secret: it costs one hash and removes
/// the class of attack where a leaked authorization code is enough on its own.
pub fn pkce() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    #[allow(dead_code)]
    access_token: String,
}

/// Exchange the code for tokens and return the subject.
///
/// The subject is all that is kept. Nothing here calls an API on the user's
/// behalf, so an access token retained past this point would be a credential
/// held for no reason.
pub async fn exchange_code(
    http: &reqwest::Client,
    oidc: &Oidc,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> AppResult<String> {
    let response = http
        .post(format!("{}/oauth2/token", oidc.issuer))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", &oidc.client_id),
            ("client_secret", &oidc.client_secret),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    // Never repeat the body back: it can carry token material.
    if !response.status().is_success() {
        return Err(AppError::Upstream(format!(
            "token endpoint returned {}",
            response.status()
        )));
    }

    let token: TokenResponse = response
        .json()
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    // The id_token arrived directly from the issuer over TLS, in a
    // back-channel response to a request we made — there is no untrusted
    // party in the path, so there is nothing signature verification would
    // catch here. It exists for tokens that arrive via the browser instead.
    let id_token = token.id_token.ok_or(AppError::Upstream(
        "token response carried no id_token".to_string(),
    ))?;
    let payload = id_token
        .split('.')
        .nth(1)
        .ok_or(AppError::Upstream("id_token is not a JWT".to_string()))?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| AppError::Upstream("id_token payload is not base64".to_string()))?;
    let claims: serde_json::Value = serde_json::from_slice(&payload)
        .map_err(|_| AppError::Upstream("id_token payload is not JSON".to_string()))?;
    claims
        .get("sub")
        .and_then(|s| s.as_str())
        .map(str::to_string)
        .ok_or(AppError::Upstream("id_token carried no sub".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Oidc;

    #[test]
    fn pkce_challenge_is_the_sha256_of_the_verifier() {
        let (verifier, challenge) = pkce();
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);
    }

    #[test]
    fn authorize_url_carries_every_required_parameter_and_escapes_the_redirect() {
        let oidc = Oidc {
            issuer: "https://auth.example.com".to_string(),
            client_id: "mariastew".to_string(),
            client_secret: "secret".to_string(),
        };
        let url = authorize_url(
            &oidc,
            "https://mariastew.example.com/auth/callback",
            "csrf-token",
            "the-challenge",
        );
        let parsed = Url::parse(&url).unwrap();
        let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();

        assert_eq!(pairs["client_id"], "mariastew");
        assert_eq!(
            pairs["redirect_uri"],
            "https://mariastew.example.com/auth/callback"
        );
        assert_eq!(pairs["response_type"], "code");
        assert_eq!(pairs["scope"], "openid offline_access");
        assert_eq!(pairs["state"], "csrf-token");
        assert_eq!(pairs["code_challenge"], "the-challenge");
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert!(
            url.contains("%3A"),
            "redirect URI's colon should be escaped"
        );
        assert!(
            url.contains("%2F"),
            "redirect URI's slash should be escaped"
        );
    }
}
