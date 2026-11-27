//! The routes, the security headers every answer carries, and the assets the
//! pages load.
//!
//! The pages are askama templates drawn with the kōan web kit's components
//! (`koan-kit-web`); the glue between them, the headers and the fingerprinted
//! stylesheet come from `askama_datastar`. No page runs script, so Datastar's
//! own script is not served.

use askama_datastar::{Asset, Csp, SecurityHeaders};
use axum::Router;
use axum::routing::{get, post};
use koan_kit_web as kit;
use tower_http::trace::TraceLayer;

use crate::state::AppState;
use crate::{register, routes};

#[cfg(test)]
mod escaping;

const CSS_PATH: &str = "/assets/app.css";
/// Beside the stylesheet, where its relative `url()` resolves.
const FONT_PATH: &str = "/assets/geist-mono.woff2";

/// Baked into the binary rather than served from a volume: it is fetched
/// mid-authentication, so the deployment is one artefact with nothing else to
/// mount and nothing to go stale against the templates it styles. `mise run
/// css` compiles it from `styles/` and the kit's source; the font it names is
/// the kit's, served from the crate.
const CSS_SOURCE: &[u8] = include_bytes!("../assets/app.css");
static CSS: Asset = Asset::new(CSS_SOURCE, "text/css; charset=utf-8");

/// The stylesheet's address, fingerprinted, for the page's head.
pub fn css_url() -> String {
    CSS.url(CSS_PATH)
}

/// The shared policy with script denied outright. A login provider is the last
/// page that should be executing anything it did not have to, and the consent
/// screen is a form.
///
/// `form-action` stays `'self'`: the consent decision answers with a page that
/// refreshes to the client rather than with a redirect, which `form-action`
/// would govern (see `continue/page.html`).
fn csp() -> Csp {
    Csp::new().deny("script-src")
}

/// Every route, behind the security headers.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(routes::index))
        .route("/healthz", get(|| async { "ok" }))
        .route(CSS_PATH, get(CSS.serve()))
        .route(FONT_PATH, get(kit::font::serve))
        .route("/auth/login", get(routes::login))
        .route("/auth/github/callback", get(routes::github_callback))
        .route(
            "/auth/consent",
            get(routes::consent).post(routes::consent_decision),
        )
        .route("/register", post(register::register))
        .layer(SecurityHeaders::new(&csp()))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header};
    use tower::ServiceExt as _;

    #[tokio::test]
    async fn every_response_carries_the_security_headers() {
        let app = Router::new()
            .route("/", get(|| async { "hi" }))
            .layer(SecurityHeaders::new(&csp()));

        let response = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        let headers = response.headers();
        let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(csp.contains("font-src 'self'"));
        assert!(csp.contains("form-action 'self'"));
        // A login provider executing script it did not need is the whole class
        // of bug this closes, and no page here wants any.
        assert!(csp.contains("script-src 'none'"));
        assert!(
            !csp.contains("unsafe-inline") && !csp.contains("unsafe-eval"),
            "the CSP has a script hatch"
        );
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY");
        assert_eq!(headers[header::REFERRER_POLICY], "same-origin");
    }

    /// The kit's stylesheet names the font relative to itself, so the route
    /// that serves it has to sit beside the stylesheet's.
    #[test]
    fn the_stylesheet_names_the_font_it_is_served_beside() {
        let css = std::str::from_utf8(CSS_SOURCE).unwrap();
        // The committed stylesheet asks for this release's font, by the hash
        // the head preloads and the route answers as immutable.
        assert!(
            css.contains(&format!("url({})", kit::font::url("app.css"))),
            "the stylesheet names another kit release's font: run `mise run css`"
        );
        assert!(kit::font::url(&css_url()).starts_with(&format!("{FONT_PATH}?")));
        assert!(css.contains("box-sizing:border-box"), "no preflight");
        assert!(css.contains(".max-w-form"), "utilities missing");
    }

    /// Escaping is what keeps a self-registered client's name and Hydra's
    /// strings from becoming markup, so no template opts out of it.
    #[test]
    fn no_template_opts_out_of_escaping() {
        fn templates(dir: &std::path::Path, found: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    templates(&path, found);
                    continue;
                }
                let body = std::fs::read_to_string(&path).unwrap();
                for line in body.lines() {
                    if line.contains("|safe") || line.contains("escape(") {
                        found.push(format!("{}: {}", path.display(), line.trim()));
                    }
                }
            }
        }
        let mut found = Vec::new();
        templates(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("templates"),
            &mut found,
        );
        assert_eq!(found, Vec::<String>::new());
    }
}
