# mariastew

Paste a magnet on a phone, and later open Infuse and watch the thing.

A small Rust service in front of aria2. aria2 does the downloading and holds
all the state — there is no database on this side, so a restart re-reads
reality instead of reconciling with it, and a signed-in session lives only in
memory, so a deploy signs everyone out. The frontend is server-rendered HTML
patched over SSE ([Datastar](https://data-star.dev), vendored at
`assets/datastar.js`), not a client-side app.

## What a row says it is doing

A collapsed row answers "how is it going" — name, state, bar, destination.
Expanding it answers "what is aria2 actually doing", which needs rather more
than a percentage:

- **The state is granular where the waiting happens.** "starting" used to
  cover everything between pasting a magnet and the first byte, which is the
  whole of the time anyone spends wondering. It is now *finding peers* (the
  magnet has resolved to nobody yet — the state a dead magnet sits in
  forever), *fetching metadata* (peers are answering; slow here is ordinary),
  *queued* (parked behind `maxConcurrentDownloads` — previously diagnosed as
  "no seeders", which looks like a fault and is not one), or *checking files*
  (aria2 is hashing data that was already on disk, which reads as zero speed
  with peers connected and was otherwise indistinguishable from stalled).
- **Readings, not just a bar:** time left, bytes given back and the share
  ratio, peers against seeders, and the piece count and size — which is the
  explanation for both lumpy progress and for a deselected file landing
  anyway.
- **The file list, deselected files included.** What `filter::is_garbage`
  refused reached the disk and the pod's log and nowhere else, so "why did it
  not download that one" had no answer on the page.
- **`errorCode` in words.** aria2 fills `errorMessage` in for some failures
  and leaves it empty for plenty of others; a row that failed with nothing
  written on it was the ordinary shape of "it broke and nothing says why". The
  code is always there, so the ones reachable from a magnet are named
  (`error_code_meaning` in `src/aria2.rs`).

### The Logs panel

Per torrent, in the expanded row: the account of what happened to it, kept in
memory by `src/activity.rs`. It exists because the interesting part of adding
a magnet happens *here* and aria2 has never heard of it — `routes::finish_add`
runs detached from the request that started it, and its resolve, its file
selection and its failures went only to the pod's log. A magnet that never
resolved left a row reading "starting" indefinitely with the explanation
sitting in `kubectl logs`.

It is live for free: the panel is part of the row markup the SSE stream
already patches once a second (`patch_elements`), so an open panel refreshes
in place with no second connection per torrent and nothing to leak when it is
closed.

A log follows the torrent rather than the gid. A magnet resolves under one gid
and `follow-torrent` spawns the real download under another; the first
disappears from every list this UI reads at the moment the second appears, so
`Activity::link` points the second at the first's log and both names reach one
record from then on.

This is the only state on this side of aria2, and it is deliberately bounded
and lost on restart: it explains how a download got where it is, while *where
it is* still comes from aria2. A restarted pod re-reads reality exactly as
before and loses only the narrative — a download already in the queue when the
pod started simply has no panel, rather than an empty one implying its history
went missing.

## Why files land straight in the library

Downloads are written directly into the media tree the picker offers, not a
staging directory that something else sweeps later. That is safe because the
scene-garbage filter (`src/filter.rs`) runs as early as it can: adding a
magnet resolves under its own gid first, `follow-torrent` spawns the real
download from the resolved metadata, `filter::is_garbage` picks the indices
worth keeping from *that* download's own file list — not the resolving gid's,
which always has exactly one entry, itself — and `aria2.changeOption` applies
the selection to it. `finish_add_inner` pauses the download the moment it
exists and unpauses it only after `changeOption` has taken, which closes most
(not all — see below) of the window a full, unfiltered selection would
otherwise fetch in.

There is no `bt-metadata-only` pass ahead of this that stops before any
content flows: it stops `follow-torrent` from ever spawning the real download
at all, so `finish_add_inner` would poll for a `followedBy` that never
arrives (see the commit that removed it for the production incident this
caused). Selection is applied to a download that is already running, not one
that hasn't started yet — the pause above is what limits the exposure, not
a delay before it exists.

aria2 also downloads whole pieces regardless of selection, so a small
deselected file sharing a piece boundary with a selected one can land anyway
even once selection is correct. `notify::sweep_garbage` runs from the same
completion watch that sends the Telegram message, deletes whatever is both
deselected and `filter::is_garbage`, and never touches a selected file or one
that is merely small. This is the "line of code rather than a design change"
a stray zero-byte file was always expected to need — and now also the
backstop for whatever the pause above does not catch in time.

## One image, run twice

The service and `aria2c` ship in the same container image (see `Dockerfile`);
the pod runs it as two containers sharing a network namespace. That puts
aria2's JSON-RPC on `127.0.0.1:6800`, reachable only from inside the pod — so
aria2 carries no credential of its own, and this service is the only gate in
front of it.

Peers reach aria2 on a fixed port (`listenPort`, 51413), published on the
node and forwarded from the house router by the `mariastew-portmap` pod. The
port is fixed because nothing can forward one that changes on restart, and
the mapper is a separate host-network pod because UPnP discovery is an SSDP
multicast the pod network does not carry — being on the LAN means leaving the
NetworkPolicy, and the pod that writes to the media library is not the one to
take out of its confinement for that.

Being reachable is not only about seeding. A peer nobody can dial connects
only to those who accept its own connections, and clients rank unconnectable
peers last when choking, so it depresses download speed too — the usual
explanation for a well-seeded torrent crawling. Before this existed a finished
torrent sat at `seeder: true` with zero peers and zero bytes uploaded, which
is seeding in name only.

Set `upnp: false` where the router has UPnP disabled or a forward is
configured by hand. The mapper is then not created and aria2 goes back to
being outbound-only, which makes a row reading "can't connect" (peers exist,
none connected) ordinary rather than a fault — see `Health` in `src/aria2.rs`.

Bandwidth is intentionally unthrottled in both directions
(`maxOverallDownloadLimit` / `maxOverallUploadLimit` default to `0`). The
media volume is a mechanical disk in a USB enclosure and saturates well before
a network link does, so the knob that actually matters is
`maxConcurrentDownloads` — concurrent torrents are concurrent write streams
landing in different regions of one spindle, which is a seek storm rather
than a throughput problem. Lower it first if downloads crawl while the
network looks idle.

Egress is deliberately **not** routed through the estate's VPN exit nodes
(see the `NetworkPolicy` in `packages/mariastew/src/mariastew.ts`): the
traffic is ordinary home-network downloading, and datacentre IP ranges are
widely tracker-blocked, so routing it through an exit would make it slower
and less welcome on the swarm for no benefit.

## Seeding, and why cancel has two meanings

aria2 is run with `--seed-ratio=0.0`, which means seed with no ratio limit —
**not** `--seed-time=0`, which would mean don't seed at all. A finished
torrent therefore never leaves aria2's active list on its own; it just stops
receiving and starts only uploading. That is why the UI tracks "finished" as
a property of a still-active row (`Download::is_finished` in `src/aria2.rs`)
rather than a separate list, and why the remove button means two different
things depending on that property (`routes::remove`): on an unfinished
download it deletes the partial files along with the aria2 entry — a
half-downloaded episode sitting in the library is the mess this avoids — and
on a finished one it only stops seeding, leaving the files in place: that is
stopping an upload, not undoing a download, and deleting the episode would be
astonishing.

## Auth

An OIDC client of the estate's own Hydra instance (`src/auth/`), which is
already public with a GitHub allowlist in front of it — who may sign in is
decided there, so there is no second allowlist here. PKCE is used even though
this client also holds a secret; it costs one hash and removes the class of
attack where a leaked authorization code alone is enough.

`auth::extract::require_session` wraps the entire protected router as one
layer (`src/routes.rs`'s `router()`, mounted under it in `src/main.rs`)
rather than being applied per route. aria2's RPC has no auth of its own, so
any route that reached it without going through this layer would be full
control of the download queue and write access to the media tree — wrapping
the whole router means a route added later is protected by construction
rather than by remembering to decorate it.

## Routes

Everything below `/` requires a session; `/healthz`, the two `/assets/*`
files, and `/auth/*` are the only routes outside that layer (`src/main.rs`).

| Route | Method | What |
|---|---|---|
| `/` | GET | The page: current roots and the download list |
| `/stream` | GET | SSE stream, one tick per second (`routes::TICK_SECS`), patching the download list in place |
| `/add` | POST | `magnet` + `dir` form fields — validates and starts the magnet resolving, then returns `202` immediately; the poll, the filter, and applying the selection run detached (see `routes::finish_add`), and their outcome shows up through `/stream` like any other download |
| `/downloads/{gid}/pause` | POST | |
| `/downloads/{gid}/resume` | POST | |
| `/downloads/{gid}/remove` | POST | See "Seeding, and why cancel has two meanings" above |
| `/browse` | GET | `path` query param — lists subdirectories of a configured root, for the destination picker |
| `/mkdir` | POST | `parent` + `name` form fields — makes a directory and returns the picker rooted there |
| `/healthz` | GET | Kubelet probe, no auth |
| `/auth/login`, `/auth/callback`, `/auth/logout` | GET | The OIDC round trip |

Every path a caller supplies — the destination on add, the path to browse or
create — is resolved through `Config::resolve`/`resolve_existing`
(`src/config.rs`), which refuses anything not lexically inside a configured
root and, for anything that must already exist, re-checks the canonicalised
result against the canonicalised roots so a symlink cannot point the request
outside them.

## Configuration

Read once at boot (`src/config.rs`); a missing or malformed value fails
startup rather than the request that first needs it.

| Variable | Required | Default | What |
|---|---|---|---|
| `ROOTS` | Yes | — | `name:/path,name:/path` — each is both a pod mount and a root the picker may browse into or write under |
| `PUBLIC_URL` | Yes | — | Where this is reached from outside; must match the OIDC redirect URI, since the pod cannot infer it from a request it hasn't had yet |
| `OIDC_ISSUER` | Yes | — | Hydra's issuer URL |
| `OIDC_CLIENT_ID` | Yes | — | |
| `OIDC_CLIENT_SECRET` | Yes | — | |
| `BIND_ADDR` | No | `0.0.0.0:8080` | |
| `ARIA2_RPC_URL` | No | `http://127.0.0.1:6800/jsonrpc` | |
| `TELEGRAM_BOT_TOKEN` | No | — | Must be set together with `TELEGRAM_CHAT_ID` or startup fails — a bot token with no chat id would otherwise fail on the first send, hours after the deploy that introduced it |
| `TELEGRAM_CHAT_ID` | No | — | See above. Both absent means no notifications, treated as normal |

Telegram only fires on the two events worth interrupting someone for: a
download finishing, and one failing (`src/notify.rs`). Starting one isn't
announced — that reports something the caller just did themselves. The
watcher seeds its own state from the first poll rather than announcing
whatever it finds already sitting there, so a restart doesn't re-announce
every torrent that finished while the pod was down.

## Deployment

Packaged as one image (`Dockerfile`) built and pushed by
`.github/workflows/build-mariastew-container.yml`, and deployed by
`packages/mariastew` (`createMariastew`) as a single-replica Deployment with
`Recreate` strategy — the pod holds `hostPath` mounts on one node, and a
rolling surge would put the incoming pod on the same directories as the one
it's replacing.

Two decisions worth stating plainly, because they diverge from what an
initial plan for this service assumed:

- **The crate compiles inside the `Dockerfile`**, rather than a CI job
  building a binary that the image then copies in. The repository's reusable
  container workflow builds from a Dockerfile context and has no way to
  consume a pre-built artefact, so a copied-in binary would mean a bespoke
  pipeline instead of the one every other container here already uses. Each
  architecture builds on its own native runner, so nothing is paid in QEMU
  emulation for compiling on-image.
- **The runtime base is `alpine`, not `scratch`.** It has to carry `aria2c`
  regardless, and needs a CA bundle even for the Rust binary alone: reqwest's
  `rustls` feature pulls in `rustls-platform-verifier`, which reads the
  system trust store and does not fall back to compiled-in webpki roots. One
  `apk add ca-certificates` covers both binaries, since they share the OS
  trust store — see the comment on that line in the `Dockerfile` for the
  exact failure this avoids.

Releasing is a `Cargo.toml` version bump: CI sees a version with no matching
`mariastew-v<version>` release, publishes the image, and
`update-apps.yml`/`versions.ts` move the pin in `Pulumi.main.yaml` on its
next run, after confirming the image actually published.

## Local development

```sh
mkdir -p /tmp/mariastew/tv
BIND_ADDR=127.0.0.1:8080 ROOTS="tv:/tmp/mariastew/tv" PUBLIC_URL=https://x.example.com \
OIDC_ISSUER=https://auth.example.com OIDC_CLIENT_ID=x OIDC_CLIENT_SECRET=y \
cargo run
```

`OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` are still required at boot
(`Config::from_env`) but nothing has to actually be able to reach that issuer:
visit `http://127.0.0.1:8080/auth/dev-login` instead of `/auth/login` and it
mints a session directly, skipping the OIDC round trip entirely. This route
only exists in a debug build — `cargo build --release`, what the Dockerfile
runs, does not compile it in (see `auth::routes::router`), and a debug binary
announces the fact with a `tracing::warn!` the moment it starts.

`aria2` is optional locally. With none running, `/` still renders — with an
empty download list and a banner saying so — rather than a 500; `/add`,
`/downloads/*`, and `/mkdir` still fail with a real error, since those are
asking aria2 to do something. Point `ARIA2_RPC_URL` at a real instance to see
downloads move.

### docker compose, if you want aria2 too

```sh
cd apps/mariastew
docker compose up --build
```

is the whole command — no separate seeding step. `docker-compose.yml`'s
`seed` service populates the picker (below) before mariastew starts, so
there is nothing to remember and no way to end up looking at an empty
library that only looks like a working one. Then visit
`http://localhost:8080/auth/dev-login`. `ROOTS` is preset to
`tv:/tv,movies:/movies`, both bind-mounted from `apps/mariastew/dev-data/`
into both containers at the same path — real downloads land there
alongside the fixtures. `docker compose down` stops and removes both
containers and the network; `dev-data/` is yours and is left alone.

#### Fixture library

An empty picker cannot reproduce a layout bug — every one found so far only
showed up because of what a real name does to the layout. `scripts/seed-dev-fixtures.ts`
populates `dev-data/movies` with ~140 entries: a fixed set of real names
from the owner's library, kept verbatim (full-width CJK brackets, runs of
consecutive spaces, a leading `www.` prefix, square brackets, commas, names
past 70 characters), padded out with deterministically generated filler so
the picker's scroll cap is exercised against a realistic count rather than
three tidy names. It also seeds `dev-data/tv` with a few shows carrying
`Season 01`/`Season 02` children, plus `Show Name S02` and
`Show.Name.Season.2` as two top-level entries — the same show named two
different real ways, which is the exact case the destination picker exists
to tell apart (#257).

The filler is generated from a seeded PRNG, not `Math.random()`, so it is
the same list on every machine and every run — a bug report against "the
17th entry" stays reproducible. The script is a no-op for anything that
already exists (`mkdir` with `recursive: true`), so `docker-compose.yml`
running it on every `up` costs nothing on the second one and never disturbs
whatever aria2 has since downloaded into the same directories.

Outside docker — the plain `cargo run` flow above, or resetting the
fixtures without a full compose cycle — use the `mise` tasks directly:
`mise run mariastew:seed`, or `mise run mariastew:seed:reset` (equivalently
`./scripts/seed-dev-fixtures.ts --reset`) to wipe `dev-data/tv` and
`dev-data/movies` and reseed from scratch — the way back to a clean
fixture-only state once a test download has piled up in there.

This mirrors "One image, run twice" above rather than inventing a second
image: `docker-compose.yml` builds one image and runs it as both services,
overriding the aria2 container's entrypoint to run `aria2c` with the same
`--enable-rpc --rpc-listen-all=false --rpc-listen-port=6800` the production
pod uses. Because that flag binds the RPC port to loopback only, the aria2
service joins mariastew's network namespace
(`network_mode: "service:mariastew"`) instead of talking to it over a
compose bridge network — the same shared-netns relationship the pod gives
the two containers for free.

The image is built from `Dockerfile.dev`, not the production `Dockerfile`:
same two-stage layout and dependency-caching trick, but a debug build, so
`/auth/dev-login` is actually compiled in. The production Dockerfile is
untouched and still `--release` — nothing here can affect what CI ships.

**Iteration loop:** `docker compose up --build` again after a source change.
The dependency-caching trick means only the final `cargo build` layer
reruns — a few seconds for a small change to `src/`, not a from-scratch
compile. A template change needs the same rebuild, for the reason above
("compiled into the binary by Askama") — there is no hot reload for
templates or the stylesheet; run `mise run css` first if a template edit
touched a class, then rebuild the image.

## Rebuilding the stylesheet

The stylesheet is generated with Tailwind + DaisyUI but the *output*
(`assets/app.css`) is committed, so `cargo build` needs no Node toolchain —
only editing a template does:

```sh
mise run css
```

This runs `tailwindcss` from `apps/mariastew/node_modules/.bin` (the app's
own devDependencies — `package.json` here declares `@jaritanet/mariastew-styles`,
separate from the Rust crate) against `styles/app.css`, minified, into
`assets/app.css`.
