//! Serves the contents of `$ROUTES` over HTTP.
//!
//! `ROUTES` is a JSON object of `<path>: <content>`; each key is served at
//! exactly that path and nothing else exists. There is no filesystem, no
//! index, and the requested path is never logged — content that is only
//! reachable by knowing an unguessable path (the reason this exists) would
//! otherwise end up listed in an access log.

use std::collections::HashMap;
use std::env;
use std::process;
use std::sync::Arc;
use std::thread;
use tiny_http::{Header, Method, Request, Response, Server};

/// Enough that one slow client can't stall the rest. This is a config server,
/// so the concern is head-of-line blocking rather than capacity.
const WORKERS: usize = 4;

const HEALTH_PATHS: [&str; 2] = ["/healthz", "/_health"];

struct Route {
    body: String,
    content_type: &'static str,
}

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
                    body: body.clone(),
                },
                other => Route {
                    content_type: "application/json; charset=utf-8",
                    body: other.to_string(),
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
            body: "ok\n".into(),
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

/// An exact route on `GET`/`HEAD`. Everything else is a 404 — the same answer
/// for a wrong path as for one that was never a route.
fn route<'a>(
    method: &Method,
    url: &str,
    routes: &'a HashMap<String, Route>,
) -> (u16, Option<&'a Route>) {
    if !matches!(method, Method::Get | Method::Head) {
        return (405, None);
    }
    let path = url.split('?').next().unwrap_or("/");
    match routes.get(path) {
        Some(route) => (200, Some(route)),
        None => (404, None),
    }
}

fn respond(request: Request, routes: &HashMap<String, Route>) {
    let (status, matched) = route(request.method(), request.url(), routes);
    let body = matched.map_or("", |r| r.body.as_str());

    let mut response = Response::from_string(body)
        .with_status_code(status)
        .with_header(header(
            "Content-Type",
            matched.map_or("text/plain; charset=utf-8", |r| r.content_type),
        ))
        // The content comes from the environment and can be a credential, so
        // nothing between here and the client may keep a copy.
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
    if status == 405 {
        response.add_header(header("Allow", "GET, HEAD"));
    }

    // Path deliberately absent — see the module docs.
    println!("{} {} {}b", request.method(), status, body.len());
    // tiny_http omits the body for HEAD on its own. A failed write is a client
    // that hung up, which is not ours to fix.
    let _ = request.respond(response);
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("static header")
}

fn main() {
    // A misconfiguration is the expected way for this to fail, so it gets one
    // legible line rather than a panic's file, line and backtrace note.
    if let Err(e) = run() {
        eprintln!("serve-from-env: {e}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let raw = env::var("ROUTES").map_err(|_| "ROUTES is unset")?;
    let routes = Arc::new(parse_routes(&raw)?);
    let port: u16 = match env::var("PORT") {
        Ok(p) => p.parse().map_err(|_| format!("PORT is not a port: {p}"))?,
        Err(_) => 8080,
    };
    let server =
        Arc::new(Server::http(("0.0.0.0", port)).map_err(|e| format!("cannot bind :{port}: {e}"))?);
    println!("serving {} routes on :{port}", routes.len());

    let workers: Vec<_> = (0..WORKERS)
        .map(|_| {
            let (server, routes) = (Arc::clone(&server), Arc::clone(&routes));
            thread::spawn(move || {
                while let Ok(request) = server.recv() {
                    respond(request, &routes);
                }
            })
        })
        .collect();
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
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

    #[test]
    fn serialises_structured_content_and_passes_strings_through() {
        let r = routes();
        assert_eq!(
            r["/deadbeef.json"].body,
            r#"{"outbounds":[{"tag":"hy2-primary-443"}]}"#
        );
        assert_eq!(r["/cafe1234.json"].body, r#"{"outbounds":[]}"#);
        assert_eq!(r["/version"].body, "1.2.3");
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
    fn serves_a_route_exactly() {
        let r = routes();
        for url in ["/deadbeef.json", "/deadbeef.json?flavour=sing-box"] {
            let (status, matched) = route(&Method::Get, url, &r);
            assert_eq!(
                (status, matched.map(|m| m.body.as_str())),
                (200, Some(r["/deadbeef.json"].body.as_str())),
                "{url}"
            );
        }
        assert_eq!(route(&Method::Head, "/deadbeef.json", &r).0, 200);
    }

    #[test]
    fn never_lists_or_hints_at_what_exists() {
        let r = routes();
        for url in [
            "/",
            "/nope.json",
            "/deadbeef.json/",
            "/deadbeef",
            "/deadbee",
        ] {
            assert_eq!(route(&Method::Get, url, &r).0, 404, "{url}");
        }
    }

    #[test]
    fn is_healthy_on_every_spelling_and_rejects_writes() {
        let r = routes();
        for path in HEALTH_PATHS {
            let (status, matched) = route(&Method::Get, path, &r);
            assert_eq!(
                (status, matched.map(|m| m.body.as_str())),
                (200, Some("ok\n")),
                "{path}"
            );
        }
        assert_eq!(route(&Method::Post, "/deadbeef.json", &r).0, 405);
    }

    #[test]
    fn lets_a_route_override_a_health_path() {
        for path in HEALTH_PATHS {
            let r = parse_routes(&format!(r#"{{"{path}": "mine"}}"#)).expect("parses");
            let (status, matched) = route(&Method::Get, path, &r);
            assert_eq!(
                (status, matched.map(|m| m.body.as_str())),
                (200, Some("mine")),
                "{path}"
            );
        }
    }

    /// The wire behaviour the routing table can't prove: framing, and that a
    /// HEAD carries the length without the body.
    #[test]
    fn speaks_http() {
        let server = Server::http("127.0.0.1:0").expect("bind");
        let port = server.server_addr().to_ip().expect("ip").port();
        thread::spawn(move || {
            let r = routes();
            while let Ok(request) = server.recv() {
                respond(request, &r);
            }
        });
        let body = routes()["/deadbeef.json"].body.clone();

        let (head, got) = request(port, "GET /deadbeef.json HTTP/1.1");
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(
            head.contains("Content-Type: application/json; charset=utf-8"),
            "{head}"
        );
        assert!(head.contains("Cache-Control: no-store"), "{head}");
        assert_eq!(got, body);

        let (head, got) = request(port, "HEAD /deadbeef.json HTTP/1.1");
        assert!(
            head.contains(&format!("Content-Length: {}", body.len())),
            "{head}"
        );
        assert_eq!(got, "");

        assert!(
            request(port, "GET /nope HTTP/1.1")
                .0
                .starts_with("HTTP/1.1 404")
        );
    }

    /// Head and body of one request over a fresh connection, so no keep-alive
    /// bookkeeping is needed to know where the body ends.
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
