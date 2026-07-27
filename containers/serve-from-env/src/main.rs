//! Serves the contents of `$ROUTES` over HTTP.
//!
//! `ROUTES` is a JSON object of `<path>: <content>`; each key is served at
//! exactly that path and nothing else exists. There is no filesystem, no
//! index, and the requested path is never logged — content that is only
//! reachable by knowing an unguessable path (the reason this exists) would
//! otherwise end up listed in an access log.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::env;
use std::process;
use std::sync::Arc;

const HEALTH_PATHS: [&str; 2] = ["/healthz", "/_health"];

struct Route {
    /// `Bytes` so serving a route is a refcount bump rather than a copy: axum
    /// handlers are `FnOnce + Clone`, so a body is cloned on every request.
    body: Bytes,
    content_type: &'static str,
}

type Routes = Arc<HashMap<String, Route>>;

/// Parses `ROUTES` into what gets served.
///
/// A string value is served verbatim, with its type guessed from the path's
/// extension; anything else is serialised as JSON. That way a caller holding
/// structured config passes it straight in rather than stringifying first.
///
/// Anything wrong is an error rather than a server that answers 404 to
/// everything — which reads as the client's bug, not the deploy's.
fn parse_routes(raw: &str) -> Result<HashMap<String, Route>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("ROUTES is not JSON: {e}"))?;
    let object = parsed
        .as_object()
        .ok_or("ROUTES must be a JSON object of path -> content")?;
    if object.is_empty() {
        return Err("ROUTES is empty".into());
    }

    let mut routes: HashMap<String, Route> = object
        .iter()
        .map(|(path, content)| {
            if !path.starts_with('/') {
                return Err(format!("route must start with a slash: {path}"));
            }
            let route = match content {
                serde_json::Value::String(body) => Route {
                    content_type: content_type(path),
                    body: Bytes::from(body.clone()),
                },
                other => Route {
                    content_type: "application/json; charset=utf-8",
                    body: Bytes::from(other.to_string()),
                },
            };
            Ok((path.clone(), route))
        })
        .collect::<Result<_, _>>()?;

    // Probe targets, unless ROUTES already defines them — both spellings,
    // because which one a chart reaches for is not worth a deploy to discover.
    // Living in the table rather than in the handler is what makes them
    // overridable.
    for path in HEALTH_PATHS {
        routes.entry(path.into()).or_insert(Route {
            body: Bytes::from_static(b"ok\n"),
            content_type: "text/plain; charset=utf-8",
        });
    }
    Ok(routes)
}

/// Enough of a type map to cover what a config server actually holds. Plain
/// text is the fallback because an extensionless route is far more often a
/// document than a download.
fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("json") => "application/json; charset=utf-8",
        Some("yaml" | "yml") => "application/yaml; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("xml") => "application/xml; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        _ => "text/plain; charset=utf-8",
    }
}

/// Every request lands in the fallback, and routing is a lookup in our own map.
///
/// `ROUTES` keys are deliberately never registered as router paths. `matchit`
/// reads `{...}` as a capture and **panics** while parsing a malformed one, so
/// registering them would turn a typo in a Secret into a crash at boot — one
/// `catch_unwind` could not contain, since the release profile aborts. A capture
/// would also match paths beyond the key, which is the wrong direction to fail
/// in for a server whose paths are its secrets.
fn build_app(routes: Routes) -> Router {
    Router::new()
        .fallback(serve)
        .layer(middleware::from_fn(guard_headers))
        .with_state(routes)
}

async fn serve(State(routes): State<Routes>, request: Request) -> Response {
    let allowed = matches!(*request.method(), Method::GET | Method::HEAD);
    // `path()` excludes the query string, so `?sub=…` cannot hide a route, and it
    // is the raw target: keys match byte for byte, with no decoding step.
    let matched = allowed.then(|| routes.get(request.uri().path())).flatten();

    let (status, body, content_type) = match (allowed, matched) {
        (false, _) => (
            StatusCode::METHOD_NOT_ALLOWED,
            Bytes::new(),
            "text/plain; charset=utf-8",
        ),
        (true, Some(route)) => (StatusCode::OK, route.body.clone(), route.content_type),
        (true, None) => (
            StatusCode::NOT_FOUND,
            Bytes::new(),
            "text/plain; charset=utf-8",
        ),
    };

    // Every outcome logs here, refusals included — an operator wants to see
    // someone POSTing at this. Method and status only, never the path: see the
    // module docs, and note this is also why `tower_http::TraceLayer` must not be
    // added, since it logs the URI, which here is the credential.
    println!("{} {} {}b", request.method(), status.as_u16(), body.len());

    // hyper drops the body of a HEAD response itself, keeping the length.
    let mut response = (
        status,
        [(header::CONTENT_TYPE, HeaderValue::from_static(content_type))],
        body,
    )
        .into_response();
    if status == StatusCode::METHOD_NOT_ALLOWED {
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
    }
    response
}

/// Headers every response needs, 404s and 405s included, so none can escape
/// without them.
async fn guard_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    // The content comes from the environment and can be a credential, so nothing
    // between here and the client may keep a copy.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[tokio::main]
async fn main() {
    // A misconfiguration is the expected way for this to fail, so it gets one
    // legible line rather than a panic's file, line and backtrace note.
    if let Err(e) = run().await {
        eprintln!("serve-from-env: {e}");
        process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let raw = env::var("ROUTES").map_err(|_| "ROUTES is unset")?;
    let routes: Routes = Arc::new(parse_routes(&raw)?);
    let port: u16 = match env::var("PORT") {
        Ok(p) => p.parse().map_err(|_| format!("PORT is not a port: {p}"))?,
        Err(_) => 8080,
    };

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("cannot bind :{port}: {e}"))?;
    println!("serving {} routes on :{port}", routes.len());

    axum::serve(listener, build_app(routes))
        .await
        .map_err(|e| format!("serve failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpStream;

    const RAW: &str = r#"{
        "/deadbeef.json": {"outbounds": [{"tag": "hy2-primary-443"}]},
        "/cafe1234.json": "{\"outbounds\":[]}",
        "/version": "1.2.3"
    }"#;

    fn routes() -> HashMap<String, Route> {
        parse_routes(RAW).expect("fixture parses")
    }

    fn body_of(routes: &HashMap<String, Route>, path: &str) -> String {
        String::from_utf8(routes[path].body.to_vec()).expect("utf8")
    }

    #[test]
    fn serialises_structured_content_and_passes_strings_through() {
        let r = routes();
        assert_eq!(
            body_of(&r, "/deadbeef.json"),
            r#"{"outbounds":[{"tag":"hy2-primary-443"}]}"#
        );
        assert_eq!(body_of(&r, "/cafe1234.json"), r#"{"outbounds":[]}"#);
        assert_eq!(body_of(&r, "/version"), "1.2.3");
    }

    #[test]
    fn types_content_by_extension() {
        let r = routes();
        assert_eq!(
            r["/cafe1234.json"].content_type,
            "application/json; charset=utf-8"
        );
        assert_eq!(r["/version"].content_type, "text/plain; charset=utf-8");
        // Structured content is JSON whatever the path says.
        assert_eq!(
            r["/deadbeef.json"].content_type,
            "application/json; charset=utf-8"
        );
    }

    #[test]
    fn refuses_input_that_would_serve_nothing_usable() {
        for raw in ["", "nope", "[]", "null", "{}", r#"{"relative.json": {}}"#] {
            assert!(parse_routes(raw).is_err(), "{raw} should be rejected");
        }
    }

    #[test]
    fn health_paths_default_in_and_stay_overridable() {
        let r = routes();
        for path in HEALTH_PATHS {
            assert_eq!(body_of(&r, path), "ok\n", "{path}");
        }
        for path in HEALTH_PATHS {
            let mine = parse_routes(&format!(r#"{{"{path}": "mine"}}"#)).expect("parses");
            assert_eq!(body_of(&mine, path), "mine", "{path}");
        }
    }

    /// Router-pattern syntax in a key is data, not a pattern: it is served at its
    /// literal path and matches nothing else. Registering keys with the router
    /// would panic here instead, at boot, on content from a Secret.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_key_that_looks_like_a_route_pattern_is_just_a_key() {
        let raw = r#"{"/{evil}.json": "literal", "/{*splat}": "also literal"}"#;
        let parsed = parse_routes(raw).expect("no panic parsing pattern-ish keys");
        let port = spawn(parsed).await;

        // Served at its literal path, capture syntax and all.
        assert_eq!(get(port, "/{evil}.json").1, "literal");
        assert_eq!(get(port, "/{*splat}").1, "also literal");
        // And matching nothing else: not a sibling, not a deeper path, and not
        // the percent-encoded spelling — comparison is against the raw target,
        // with no decoding step for a key to hide behind.
        for path in ["/anything", "/x/y/z", "/%7Bevil%7D.json"] {
            assert!(get(port, path).0.starts_with("HTTP/1.1 404"), "{path}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn serves_routes_and_refuses_the_rest() {
        let r = routes();
        let profile = body_of(&r, "/deadbeef.json");
        let port = spawn(r).await;

        let (head, body) = get(port, "/deadbeef.json");
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(
            head.contains("content-type: application/json; charset=utf-8"),
            "{head}"
        );
        assert!(head.contains("cache-control: no-store"), "{head}");
        assert!(head.contains("x-content-type-options: nosniff"), "{head}");
        assert_eq!(body, profile);

        // A query string never hides a route.
        assert_eq!(get(port, "/deadbeef.json?flavour=sing-box").1, profile);

        // Exact match or nothing: no index, no extensionless alias, nothing to
        // traverse to, and every miss looks identical.
        for path in [
            "/",
            "/nope.json",
            "/deadbeef",
            "/deadbeef.json/",
            "/../version",
        ] {
            let (h, b) = get(port, path);
            assert!(h.starts_with("HTTP/1.1 404"), "{path}: {h}");
            assert!(
                h.contains("cache-control: no-store"),
                "{path} missed no-store"
            );
            assert_eq!(b, "", "{path} leaked a body");
        }
    }

    /// The wire behaviour a handler test can't prove: that HEAD carries the
    /// length without the body, and that a rejected method says what is allowed.
    #[tokio::test(flavor = "multi_thread")]
    async fn head_carries_length_only_and_405_says_allow() {
        let r = routes();
        let len = body_of(&r, "/version").len();
        let port = spawn(r).await;

        let (head, body) = request(port, "HEAD /version HTTP/1.1");
        assert!(head.contains(&format!("content-length: {len}")), "{head}");
        assert_eq!(body, "");

        for line in ["POST /version HTTP/1.1", "DELETE /version HTTP/1.1"] {
            let (head, body) = request(port, line);
            assert!(head.starts_with("HTTP/1.1 405"), "{line}: {head}");
            assert!(head.contains("allow: GET, HEAD"), "{line}: {head}");
            assert!(head.contains("cache-control: no-store"), "{line}: {head}");
            assert_eq!(body, "", "{line} leaked a body");
        }
    }

    async fn spawn(routes: HashMap<String, Route>) -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let app = build_app(Arc::new(routes));
        tokio::spawn(async move { axum::serve(listener, app).await });
        port
    }

    fn get(port: u16, path: &str) -> (String, String) {
        request(port, &format!("GET {path} HTTP/1.1"))
    }

    /// Head and body of one request over a fresh connection, so no keep-alive
    /// bookkeeping is needed to know where the body ends. Deliberately raw: a
    /// client that normalises `..` for us would not test what a proxy can send.
    ///
    /// Blocking on purpose, which is why every test using it asks for a
    /// `multi_thread` runtime — on the default current-thread one, this read
    /// starves the server task it is waiting for and the test hangs forever.
    fn request(port: u16, line: &str) -> (String, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        write!(
            stream,
            "{line}\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )
        .expect("write");
        let mut reader = BufReader::new(stream);
        let mut head = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("read head");
            if line == "\r\n" || line.is_empty() {
                break;
            }
            head.push_str(&line);
        }
        let mut body = String::new();
        reader.read_to_string(&mut body).expect("read body");
        (head, body)
    }
}
