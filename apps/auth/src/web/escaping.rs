//! Every page, drawn with markup-shaped text in every field an outside party
//! controls: a self-registered client's name and the redirect URI it asks for,
//! the scopes and audience it requests, the GitHub login carried in Hydra's
//! session context, the consent challenge, and the `redirect_to` Hydra answers
//! a decision with. Each answer must carry that text escaped exactly once, and
//! no markup of the templates' or the kit's own may come out escaped.
//!
//! Hydra is a stub served here, answering with that text wherever it can.
//! Redis is never reached: no page drawn here reads a flow.

use std::sync::Arc;
use std::time::Duration;

use askama_datastar::escaping::{Guard, escaped, get, send};
use axum::body::Body;
use axum::extract::Request;
use axum::http::{StatusCode, header};
use axum::routing::{get as route_get, put};
use axum::{Json, Router};
use serde_json::json;

use crate::config::{Config, Github};
use crate::hydra::HydraAdmin;
use crate::state::AppState;
use crate::store::Store;

/// Text shaped like markup, with every character escaping changes.
const HOSTILE: &str = r#"<em>hostile "q" & 'x'</em>"#;
const WAIT: Duration = Duration::from_secs(5);

fn encoded(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// A Hydra admin API whose consent request was made by a self-registered
/// client that chose `HOSTILE` for everything it could, and whose decisions
/// send the browser to an address carrying it.
async fn hydra() -> String {
    let consent = json!({
        "client": {
            "client_id": "self-registered",
            "client_name": HOSTILE,
            "redirect_uris": [HOSTILE],
        },
        "subject": "github:1",
        "requested_scope": ["openid", HOSTILE],
        "requested_access_token_audience": [HOSTILE],
        "context": {"login": HOSTILE, "email": "a@example.test", "email_verified": true},
        "request_url": format!("https://auth.test/oauth2/auth?redirect_uri={}", encoded(HOSTILE)),
    });
    let decided = json!({
        "redirect_to": format!("https://client.test/cb?state={}&x={HOSTILE}", encoded(HOSTILE)),
    });
    let decision = move || {
        let decided = decided.clone();
        async move { Json(decided) }
    };
    let app = Router::new()
        .route(
            "/admin/oauth2/auth/requests/consent",
            route_get(move || async move { Json(consent) }),
        )
        .route(
            "/admin/oauth2/auth/requests/consent/accept",
            put(decision.clone()),
        )
        .route("/admin/oauth2/auth/requests/consent/reject", put(decision));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://{address}")
}

async fn state() -> AppState {
    let config = Config {
        bind_addr: String::new(),
        public_url: "https://auth.test".into(),
        redis_url: "redis://127.0.0.1:9".into(),
        hydra_admin_url: hydra().await,
        github: Github {
            client_id: "gh".into(),
            client_secret: "gh".into(),
            allowed: vec![HOSTILE.into()],
        },
        first_party: Vec::new(),
        gateway_audience: None,
    };
    let http = reqwest::Client::new();
    AppState {
        hydra: HydraAdmin::new(&config.hydra_admin_url, http.clone()),
        store: Store::lazy(&config.redis_url),
        config: Arc::new(config),
        http,
    }
}

fn decision(body: String) -> Request {
    Request::post("/auth/consent")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn every_page_escapes_what_others_control_exactly_once() {
    let router = super::router(state().await);
    let guard = Guard::new(&[HOSTILE])
        .templates(concat!(env!("CARGO_MANIFEST_DIR"), "/templates"))
        .unwrap()
        // What the kit's components write.
        .elements(["a", "button", "link", "meta", "title"]);
    let shown = escaped(HOSTILE);
    let mut found = Vec::new();
    let mut check = |what: &str, status: StatusCode, answer: &str, shows: bool| {
        if !status.is_success() && status != StatusCode::UNAUTHORIZED {
            found.push(format!("{what}: {status}"));
        }
        found.extend(
            guard
                .problems(answer)
                .iter()
                .map(|p| format!("{what}: {p}")),
        );
        if shows && !answer.contains(&shown) {
            found.push(format!("{what}: the hostile text is missing"));
        }
    };

    let (status, answer) = get(&router, "/", false, WAIT).await;
    check("/", status, &answer, false);

    // No flow cookie: the expired page, which names nothing it was sent.
    let address = format!("/auth/github/callback?state={}", encoded(HOSTILE));
    let (status, answer) = get(&router, &address, false, WAIT).await;
    check("the callback without a flow", status, &answer, false);

    let address = format!("/auth/consent?consent_challenge={}", encoded(HOSTILE));
    let (status, answer) = get(&router, &address, false, WAIT).await;
    check("the consent screen", status, &answer, true);
    // Name, redirect host, scope, audience, login and challenge each carry it.
    let shown_on_consent = answer.matches(&shown).count();

    let challenge = encoded(HOSTILE);
    for (what, body) in [
        ("denied", format!("challenge={challenge}")),
        ("allowed", format!("challenge={challenge}&approve=1")),
    ] {
        let (status, answer) = send(&router, decision(body), WAIT).await;
        check(what, status, &answer, true);
    }

    if shown_on_consent < 6 {
        found.push(format!(
            "the consent screen shows the hostile text {shown_on_consent} times, not 6"
        ));
    }
    assert!(found.is_empty(), "{}", found.join("\n"));
}
