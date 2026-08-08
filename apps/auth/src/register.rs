//! Dynamic Client Registration (RFC 7591), proxied to Hydra.
//!
//! Hydra advertises this as its `registration_endpoint`, so it is public and
//! unauthenticated — that is what DCR is, and Claude needs it to register a
//! client for itself. The control against abuse is not here: a registered
//! client is useless without a token, and a token issues only to a login in
//! `GH_ALLOWED`. That is why the allowlist is refused when empty.
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

pub async fn register(
    State(state): State<AppState>,
    Json(request): Json<Value>,
) -> AppResult<Response> {
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

    let created = state
        .hydra
        .create_client(&json!({
            "client_name": field("client_name", json!("Unnamed client")),
            "redirect_uris": field("redirect_uris", json!([])),
            "grant_types": field("grant_types", json!(["authorization_code", "refresh_token"])),
            "response_types": field("response_types", json!(["code"])),
            "scope": scopes.join(" "),
            "token_endpoint_auth_method": field("token_endpoint_auth_method", json!("none")),
        }))
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
