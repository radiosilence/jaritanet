//! Dynamic Client Registration (RFC 7591), proxied to Hydra.
//!
//! Hydra advertises this as its `registration_endpoint`, so it is public and
//! unauthenticated — that is what DCR is, and Claude needs it to register a
//! client for itself. A registered client is useless without a token, and a
//! token issues only to a login in `GH_ALLOWED`, which is why the allowlist is
//! refused when empty.
//!
//! That holds only for grants that pass through a login. The request reaches
//! Hydra's admin API, which honours whatever grant types it is given, and a
//! `client_credentials` client gets a token from its own secret with no login
//! at all. So the grant types, response types and authentication methods are
//! restricted here to the authorization-code flow.
//!
//! It exists as a proxy rather than a route straight to Hydra because Hydra's
//! own DCR response carries empty `client_uri`/`logo_uri`/`tos_uri` fields that
//! some clients reject, so the response is rebuilt with the empties omitted.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Scopes every registration is granted regardless of what it asked for.
///
/// Claude Desktop asks for `offline`, Claude Code for `offline_access`, and
/// Hydra rejects an authorization request whose scope is not a subset of the
/// client's. Widening here is safe because consent is still asked for — a
/// self-registered client holding a broad `scope` on paper gets a screen, and
/// the person decides.
const ALWAYS_ALLOWED: [&str; 3] = ["openid", "offline", "offline_access"];

const GRANT_TYPES: [&str; 2] = ["authorization_code", "refresh_token"];
const RESPONSE_TYPES: [&str; 1] = ["code"];
const AUTH_METHODS: [&str; 3] = ["none", "client_secret_basic", "client_secret_post"];

/// Refuses metadata asking for anything outside the authorization-code flow.
/// Absent fields are fine. Whatever passes, Hydra is sent `GRANT_TYPES` and
/// `RESPONSE_TYPES` themselves, so the list checked and the list registered
/// cannot differ.
fn check_flow(request: &Value) -> Result<(), String> {
    let within = |key: &str, allowed: &[&str]| match request.get(key) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Array(items))
            if items
                .iter()
                .all(|v| v.as_str().is_some_and(|s| allowed.contains(&s))) =>
        {
            Ok(())
        }
        Some(_) => Err(format!("{key} must be a subset of {allowed:?}")),
    };
    within("grant_types", &GRANT_TYPES)?;
    within("response_types", &RESPONSE_TYPES)?;
    match request.get("token_endpoint_auth_method") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(m)) if AUTH_METHODS.contains(&m.as_str()) => Ok(()),
        Some(_) => Err(format!(
            "token_endpoint_auth_method must be one of {AUTH_METHODS:?}"
        )),
    }
}

/// What Hydra is asked to create for a registration. Everything that decides
/// what the client may do is set here rather than taken from the request.
///
/// The audience is the gateway's, whatever the request names: self-registration
/// exists for MCP clients, and the gateway accepts a token only when its client
/// carries that audience, so a token issued to any other relying party of this
/// issuer is refused there. Without a gateway there is no audience to grant.
fn client_body(request: &Value, gateway_audience: Option<&str>) -> Value {
    let field = |key: &str, default: Value| {
        request
            .get(key)
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or(default)
    };

    let requested = field("scope", json!(""));
    let mut scopes: Vec<&str> = requested
        .as_str()
        .unwrap_or_default()
        .split_whitespace()
        .collect();
    for s in ALWAYS_ALLOWED {
        if !scopes.contains(&s) {
            scopes.push(s);
        }
    }

    let mut body = json!({
        "client_name": field("client_name", json!("Unnamed client")),
        "redirect_uris": field("redirect_uris", json!([])),
        "grant_types": GRANT_TYPES,
        "response_types": RESPONSE_TYPES,
        "scope": scopes.join(" "),
        "token_endpoint_auth_method": field("token_endpoint_auth_method", json!("none")),
    });
    if let Some(audience) = gateway_audience {
        body["audience"] = json!([audience]);
    }
    body
}

pub async fn register(
    State(state): State<AppState>,
    Json(request): Json<Value>,
) -> AppResult<Response> {
    check_flow(&request).map_err(AppError::BadRequest)?;

    let created = state
        .hydra
        .create_client(&client_body(
            &request,
            state.config.gateway_audience.as_deref(),
        ))
        .await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    // Logged so registration is visible: the endpoint is open by necessity, and
    // an unread endpoint is one nobody would notice being used.
    tracing::info!(
        client_id = created
            .get("client_id")
            .and_then(|v| v.as_str())
            .unwrap_or("?"),
        client_name = created
            .get("client_name")
            .and_then(|v| v.as_str())
            .unwrap_or("?"),
        "registered a client through DCR"
    );

    let mut out = Map::new();
    for key in [
        "client_id",
        "client_secret",
        "client_name",
        "redirect_uris",
        "grant_types",
        "response_types",
        "scope",
        "token_endpoint_auth_method",
    ] {
        if let Some(value) = created.get(key)
            && !value.is_null()
            && value.as_str() != Some("")
        {
            out.insert(key.to_string(), value.clone());
        }
    }
    out.insert("client_secret_expires_at".into(), json!(0));

    Ok((StatusCode::CREATED, Json(Value::Object(out))).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_the_code_flow_pass() {
        assert!(check_flow(&json!({})).is_ok());
        assert!(
            check_flow(&json!({
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "client_secret_post",
            }))
            .is_ok()
        );
    }

    #[test]
    fn grants_without_a_login_are_refused() {
        for grant in ["client_credentials", "implicit", "password"] {
            assert!(check_flow(&json!({ "grant_types": [grant] })).is_err());
        }
        assert!(check_flow(&json!({ "grant_types": "client_credentials" })).is_err());
        assert!(check_flow(&json!({ "response_types": ["token"] })).is_err());
        assert!(check_flow(&json!({ "token_endpoint_auth_method": "private_key_jwt" })).is_err());
    }

    #[test]
    fn the_audience_is_the_gateway_whatever_the_request_names() {
        let body = client_body(
            &json!({ "audience": ["https://evil.example"], "redirect_uris": ["https://claude.ai/cb"] }),
            Some("https://mcp.example"),
        );
        assert_eq!(body["audience"], json!(["https://mcp.example"]));
    }

    #[test]
    fn without_a_gateway_no_audience_is_sent() {
        let body = client_body(&json!({ "audience": ["https://evil.example"] }), None);
        assert!(body.get("audience").is_none());
    }
}
