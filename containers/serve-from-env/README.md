# serve-from-env

Serves `$ROUTES` — a JSON object of `<path>: <content>` — over HTTP, and
nothing else. No filesystem, no index, no config file.

```sh
ROUTES='{"/hello.json": {"hi": true}, "/version": "1.2.3"}' serve-from-env
curl localhost:8080/hello.json   # {"hi":true}
```

It exists because the alternative for "serve a few generated files" is an nginx
plus a volume plus a config, where the content is already sitting in a string
that something else generated. Here the content and the server's whole
configuration are the same environment variable, so there is nothing to keep in
sync and nothing on disk to go stale.

Written for the sing-box profiles, whose paths are unguessable hashes and whose
contents are credentials — which is why there is no directory listing, and why
the requested path is never logged.

## Behaviour

| Request                  | Response                                    |
| ------------------------ | ------------------------------------------- |
| `GET`/`HEAD` a key       | its content, `no-store`                     |
| `GET /healthz`           | `ok` — unless `ROUTES` defines the path      |
| anything else            | 404, or 405 for methods other than GET/HEAD |

Paths match exactly and must start with `/`. A string value is served verbatim
with its content type taken from the extension; any other JSON value is
serialised and served as `application/json`.

Bad input — unset, not an object, empty, unparseable, a relative path — fails at
startup rather than answering 404 to every client.

## Config

- `ROUTES` — the routing table. Required.
- `PORT` — default 8080.

Routes are read once at startup, so changed content needs a restart. Content is
bounded by the kernel's 128KiB limit on a single environment string.
