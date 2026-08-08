# auth

Hydra's login and consent provider — one login screen, independent of the
applications it signs you into.

Hydra drives the OAuth and OIDC protocol and is headless: it delegates "who is
this person" and "do they consent" to whatever `URLS_LOGIN` and `URLS_CONSENT`
point at. This is that application and nothing else. It issues no tokens, holds
no accounts, and never learns what a relying party does with the subject it
hands out.

## Why it is its own service

Hydra takes one login provider for the entire authorization server. While those
URLs pointed into the MCP gateway, the MCP gateway *was* the login screen for
every client of that Hydra — so signing in to the torrent UI went through it,
and a degraded replica returning 502 on `hydra get_consent` surfaced as
intermittent login failures on a service that has nothing else to do with it.

Nothing leaked between them; the cost was availability and comprehension.
Splitting it means adding a relying party is registering a client, and adding a
*way to sign in* happens here once for everything behind it.

## What it never knows

Which application you are signing in to. Hydra carries that in the challenge and
redirects the browser to whichever client began the flow, so this service is
application-agnostic by construction — which is why one instance serves every
client and why adding one requires nothing at GitHub.

## Load-bearing decisions

**The allowlist is the only real gate, so an empty one refuses to boot.**
Dynamic client registration cannot be closed — Claude registers its own client —
so a registered client has to be assumed hostile. What makes that survivable is
that a client is useless without a token and a token issues only to a login in
`GH_ALLOWED`. An empty allowlist plus open registration means any GitHub account
in the world; that is a refusal to start, not a warning in a log nobody reads.

**Consent is automatic for first-party clients and asked for otherwise.** A
client whose id, secret and redirect URIs came from the deploy has already been
decided about. One that registered itself can otherwise ask for — and silently
receive — a token audienced at a service it has nothing to do with.

**Not Hydra's own `skip_consent`.** It bypasses the consent endpoint entirely,
and that endpoint is where identity claims are attached. Turning it on returns
every relying party to a token carrying a bare `sub`, which leaves dashboards
displaying `github:12345` at their user. The auto-grant lives in the handler for
exactly that reason.

**The session is Hydra's, not this service's.** Accepting a login with
`remember` is what makes the second service seamless, and it lives at the
authorization server where every relying party benefits. So restarting this pod
logs nobody out, and there is no session store here to make it hard to move.

**Redis, because the state is one nonce.** All this holds is an in-flight
login — a CSRF value and the login challenge it belongs to — written once, read
once, expiring in ten minutes. `SET .. EX` and `GETDEL` are those operations
exactly, so there is no schema, no migration at boot, and no sweeper for the
rows an abandoned login leaves behind. Losing the whole store costs the logins
in flight at that instant.

**No script on any page.** The CSP is `script-src 'none'` and the consent screen
is a form. A self-registered client picks its own `client_name`, which is
rendered on that screen, so everything interpolated there is attacker-chosen and
goes through the template's escaping.

## Configuration

Everything is an environment variable, set by Pulumi (`packages/auth`), parsed
once at boot.

| Variable | |
|---|---|
| `PUBLIC_URL` | Where this is reached from outside. The GitHub callback is `${PUBLIC_URL}/auth/github/callback` and must match the OAuth App exactly. |
| `REDIS_URL` | The flow store. |
| `HYDRA_ADMIN_URL` | Cluster-internal. It accepts a login for any subject without authenticating the caller, so it is never published. |
| `GH_CLIENT_ID`, `GH_CLIENT_SECRET` | The OAuth App. One serves everything behind here. |
| `GH_ALLOWED` | Comma-separated GitHub logins. Empty is refused. |
| `FIRST_PARTY_CLIENTS` | JSON array of `{id, name, secret, redirect_uris, scopes?}`, registered with Hydra at boot. Assembled by Pulumi from the services that need auth, so a redirect URI is derived from the hostname a service already publishes rather than typed. |
| `BIND_ADDR` | Defaults to `0.0.0.0:8080`. |

## Routes

| | |
|---|---|
| `GET /auth/login` | Hydra's login challenge. Confirms the subject when Hydra says `skip`, otherwise sends the browser to GitHub. |
| `GET /auth/github/callback` | Exchanges the code, checks the allowlist, accepts the login. |
| `GET`/`POST /auth/consent` | Hydra's consent challenge, and the decision from the screen. |
| `POST /register` | Dynamic client registration (RFC 7591), proxied to Hydra. Public by design. |
| `GET /healthz` | |
| `GET /`, `GET /assets/app.css` | |

`auth.<domain>` is shared with Hydra and split by path: Hydra keeps `/oauth2/*`,
`/.well-known/*` and `/userinfo`, so the issuer relying parties discover does not
change — only which service answers the challenges.

## Adding a relying party

An entry in `FIRST_PARTY_CLIENTS`, which `packages/auth` builds from the
services declaring they need auth. Registration is derived rather than declared
on purpose: the redirect allowlist is what stands between this and an open
redirect, and a derived list cannot hold a typo, cannot keep an entry for a
service whose hostname moved, and gives no service a way to widen its own
permissions. Exact matches only — a wildcard on a hostname is how one forgotten
subdomain becomes a token thief.

## Local development

```
cargo test
cargo clippy --all-targets --locked -- -D warnings
```

Running it for real needs a Hydra and a Redis; the deployment in
`packages/auth` is the topology.
