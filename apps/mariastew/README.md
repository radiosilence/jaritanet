# mariastew

Paste a magnet on a phone, and later open Infuse and watch the thing.

A small Rust service in front of aria2. aria2 does the downloading and holds
all the state — there is no database on this side, so a restart re-reads
reality instead of reconciling with it, and a signed-in session lives only in
memory, so a deploy signs everyone out. The frontend is server-rendered HTML
patched over SSE ([Datastar](https://data-star.dev), vendored at
`assets/datastar.js`), not a client-side app.

## What a row says it is doing

A collapsed row answers "how is it going" — name, state, bar, destination, and
beside the destination the current rate and the time left. Those last two are
there because a bar raises "will this be done tonight" and cannot settle it;
behind a tap they were one tap too many. Both are absent rather than zeroed
when nothing is moving, which is also why there is no countdown on a seeding
row.

Expanding it answers "what is aria2 actually doing", which needs rather more
than a percentage:

- **The state is granular where the waiting happens.** "starting" used to
  cover everything between pasting a magnet and the first byte, which is the
  whole of the time anyone spends wondering. It is now *finding peers* (the
  magnet has not resolved), *queued* (parked behind `maxConcurrentDownloads`
  — previously diagnosed as "no seeders", which looks like a fault and is not
  one), or *checking files* (aria2 is hashing data that was already on disk,
  which reads as zero speed with peers connected and was otherwise
  indistinguishable from stalled).

  *finding peers* is deliberately **not** split further on the connection
  count. It was, briefly, on the theory that peers connected meant metadata
  was on its way — and a real dead magnet disproved it: DHT hands out peers
  that have never heard of the infohash, so the count oscillates between zero
  and a handful every few seconds while nothing arrives, which flapped both
  the badge and the activity log. Nothing in one `tellStatus` separates a
  magnet nobody has from one that is merely slow. How long it has been does,
  and that is what the log's timestamps answer.
- **Readings, not just a bar:** bytes done against total, up and down rates,
  bytes given back and the share ratio, peers against seeders, and the piece
  count and size — which is the explanation for both lumpy progress and for a
  deselected file landing anyway.
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
completion watch that sends the Telegram message, and walks the download's own
tree — the entries the torrent put directly under `dir`, never `dir` itself,
which is a library root — deleting whatever `filter::is_garbage` flags and the
directories that leaves empty.

It judges the disk rather than aria2's selection because selection is not the
only thing that lets garbage through: a download aria2 already knew about when
the service started never had one applied, so every file reads as selected, and
a `.DS_Store` some other machine wrote is in no torrent's manifest at all. The
sweep also runs once over everything already finished at startup, since a
download that completed while the pod was down never had one. It is idempotent,
so the ones that did cost a directory walk that finds nothing.

`clean-dls` in the dotfiles — the script `filter.rs` is ported from — ends by
handing the tree to `prune`, which deletes any directory under a size
threshold. That stays a decision for someone watching it happen; only
directories this sweep itself emptied go.

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

**TCP only, and the UDP half must stay unpublished.** aria2 sends its tracker
announces and DHT queries from the same port it listens on. Give that port a
UDP `hostPort` and the replies arrive addressed to it, so Cilium matches them
against the hostPort service on the way into the pod and rewrites their source
port; aria2 keys a reply to the endpoint it asked, sees a stranger, and drops
it. Every announce then times out
(`UDPT received CONNECT reply from <tracker>:<random> invalid transaction_id`)
and every DHT lookup goes unanswered — a client with no way to find a peer, so
magnets sit on "starting" forever while the swarm is healthy. Outbound DHT and
uTP are unaffected, which is how any client behind a NAT operates anyway.

DHT needs one more thing to be real: a bootstrap node (`--dht-entry-point`)
and a routing-table file it can actually write. `--dht-file-path` defaults
under `$HOME/.cache`, and HOME is unset here, so aria2 resolved it to
`//.cache` and could neither load nor save — leaving every peer lookup to run
against an empty table. It now points into `statePath` below rather than at
`/tmp`, so the table is not thrown away with the container on every deploy.

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

## The queue outlives the pod

There is no database on this side, so aria2 holding all the state means aria2
losing all the state is the whole service losing it. Every version bump
recreates the pod — `strategy: Recreate`, one node, hostPath mounts — and aria2
came back knowing nothing: the bytes survived and `--continue=true` would have
resumed them, but only if someone remembered which magnet it was and pasted it
back. Seeding torrents just stopped. Nothing said anything had been dropped;
the row was simply gone, which is cheap to notice at 1% and expensive at 90%.

`--save-session` and `--input-file` now name the same file, so what a deploy
tears down is where the next one starts. Three things make that actually work:

- **`--save-session-interval`.** A pod is killed, not asked, so a session
  written only on a clean exit is a session that is often not written. The
  interval bounds the loss to itself. aria2 hashes the session before writing
  and skips an unchanged one, and it writes `aria2.session__temp` and renames
  it into place, so there is no torn file to come back to.
- **`--force-save=true`.** aria2 calls a download whose data is complete
  *finished* even while it is still seeding, and the serialiser skips finished
  downloads unless forced. Without this the case with nothing left to resume and
  everything left to lose — a 7.84GB torrent seeding to the swarm — was the one
  case the session did not cover. It also keeps the `.aria2` control file for
  those, which is what makes a restored seed a resume rather than a
  rediscovery.
- **An init container that touches the file.** `--input-file` on a path that
  does not exist is fatal, not empty: aria2 exits with
  `errorCode=1 Failed to open the file` and the pod crash-loops. An empty file
  is fine and so is a malformed one — unknown lines are warnings — so
  "missing" is the only case there is to handle.

A magnet added through `addUri` is saved as the magnet, and the options changed
on the resolved download go with it — aria2 serialises whatever is set on the
group — so a restored torrent keeps the `dir` it was heading for and the
`select-file` the filter narrowed it to, rather than starting over and pulling
down the scene garbage that was deselected. Restoring re-fetches metadata from
the infohash, which is what the persisted DHT table now makes quick.

Nothing the interface cleared comes back. `routes::clear` follows `remove` with
`removeDownloadResult` and keeps asking until the gid is gone from every list
aria2 keeps, and a result aria2 no longer holds is not one it can save — which
is the property `--force-save` would otherwise put at risk.

`--check-integrity=true` still applies on the way back in, so a restored
torrent is re-hashed before it resumes or seeds. That is a read of everything
already on disk for each restored row, on a mechanical disk, on every deploy —
the price of never trusting bytes nobody verified, and the reason to press
**Done** on rows that are finished with rather than leaving them in the list.

### Where it lives

`statePath` (default `/var/lib/mariastew`) is a directory of its own on the
node's internal disk, holding the session and the DHT table. Deliberately not
one of `roots`: those are the media library, a share people browse and a tree
Infuse scans, and aria2's bookkeeping is neither media nor something to hand a
media scanner. The internal disk rather than the media drive because this is
the machine's state — an unmounted enclosure already leaves the pod `Pending`
on the roots, and state on the drive would go missing exactly when the drive
did.

It is mounted `Directory`, so it has to exist. kubelet creates a missing
hostPath as root, `fsGroup` does not apply to hostPath volumes, and the pod runs
as 1000, so a directory created on demand is one aria2 cannot write —
`scripts/make-seed-drive` makes it and chowns it, alongside the other local
volumes on that node. A node missing it leaves the pod `Pending` with a reason,
which is the failure worth having.

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
astonishing. The finished button says **Done** rather than "stop seeding" —
what it means to whoever presses it is that they are finished with the row,
and it keeps every file, which is the opposite of what the destructive button
in the same slot on an unfinished row does.

Removal is asynchronous on both sides. aria2 has two calls for it and each
refuses the other's downloads: `remove` stops one that is still running,
`removeDownloadResult` discards one that has already stopped — and a download
does not move between those the instant it is asked, so the second call is
refused for a moment after the first succeeds. Starting with `remove` and
giving up when it failed is what made the button look dead: an errored row and
a torrent aria2 had stopped seeding are both already-stopped, so the call that
would have worked was never reached, and the row stayed with a button that
could only fail again. `routes::clear` now runs both in the order that applies
and keeps asking until the gid is gone from the lists the page reads — the
same question the row is asking — rather than trusting either call's return.

That takes long enough to need saying so. The gid goes into `state::Clearing`
before the request answers, which renders the row as "clearing" with its
controls replaced by a spinner, on every open page rather than the one that
was clicked. It has to be server-side: the list is redrawn from aria2 once a
second, so a state held in the browser would be morphed away before it was
read. The activity log is dropped only once aria2 has confirmed the removal;
if it never does, the mark lifts, the controls come back and the row says so,
because the download really is still there.

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
| `/downloads/{gid}/remove` | POST | Marks the row `clearing` and returns `204` immediately; the removal itself runs detached (`routes::clear`) and its outcome shows up through `/stream`. See "Seeding, and why cancel has two meanings" above |
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
| `ROOTS` | Yes | — | `name:/path,name:/path` — each is both a pod mount and a root the picker may browse into or write under. The name is also what the picker calls the place: a destination reads `tv/some-show`, never the mount above it |
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

#### Every download state at once

```sh
mise run mariastew:dev:mock
```

The fixture library populates the picker; this populates the *list*. A real
aria2 shows whatever the swarm is doing, and the states most worth designing
against — stalled, can't connect, no seeders, failed — are the ones a swarm
produces on its own schedule or not at all. `scripts/mock-aria2.ts` answers
the JSON-RPC calls `src/aria2.rs` makes (`src/aria2.rs` is the only thing that
talks to aria2, so that is the whole surface) and serves one download per
`Health`, plus a queued row and a magnet still resolving.

It advances on each poll rather than serving a fixed list: the moving row
gains bytes and the magnet resolves after a few seconds into the download
`follow-torrent` would have spawned. A still list proves only the first paint
— that a row morphs in place, that an expanded row stays expanded through the
morph, and that a bar moves at all are things only a changing one can show.
Pause, resume and remove mutate its state, so the buttons do something — and
the removal calls refuse each other's downloads the way aria2's do, plus one
refusal before the discard takes. Accepting either on anything is what let
#316 pass here while being unpressable in production.

It is not a simulator and is not trying to be: it holds a list and hands it
out. Anything that depends on aria2's real behaviour — the metadata pass, the
selection filter — has its own tests in `src/filter.rs` and
`routes::tests::add_flow`.

The task is `ARIA2_RPC_URL` plus `--scale aria2=0`, because compose has no way
to say "this profile replaces that service". Port 6801, so the two can never
race for a bind and the env var is the only thing deciding which one is
talked to. For the plain `cargo run` loop, `mise run mariastew:mock` runs it
alone and `ARIA2_RPC_URL=http://127.0.0.1:6801/jsonrpc cargo run` points at
it.

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

## Icons

[Lucide](https://lucide.dev) paths, copied into `templates/icons.html` as one
Askama macro each and called inline. They replaced unicode characters, which
were never really under this service's control: an emoji comes from the
device's emoji font at its own weight, colour and baseline rather than the
text's, and `⌂` is missing from enough fonts to have arrived as a tofu box on
the one control that had nothing else in it.

Nothing is fetched or generated — they weigh less than the request that would
fetch them, and there is no JavaScript on this page to draw them with.
The shared presentation attributes live on `.icon` in `styles/app.css`, sized
in `em` so an icon is the size of the text it sits beside; a macro takes a
class for the cases that want otherwise.

A `<summary>`'s own marker comes from the user agent, so it is a filled
triangle in Chrome and something else everywhere else — the same problem
arriving through a different door. `.disclosure` takes it off and turns the
chevron inside instead; a disclosure written later gets that by using the same
two class names.

Adding one: take the `<path>` elements from
`https://unpkg.com/lucide-static/icons/<name>.svg` into a new macro, then
rebuild the stylesheet if the call site introduced a class. Every icon names
itself with `data-icon`, which is what tests assert on — a count of `<svg>`s
only says the number changed, which every new call site does.
`views::tests::nothing_is_drawn_with_a_unicode_glyph` fails the build if a
character is used instead.

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
