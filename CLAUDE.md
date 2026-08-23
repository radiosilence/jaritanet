# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Philosophy

Code should be simple, elegant, and concise. Respect the "rule of three" - only add abstractions when you see the same pattern repeated three times. Keep implementations minimal and avoid premature optimization.

**Documentation:**

- Use docblocks to document functions and explain the why, not just what
- Avoid @param tags - document parameters directly in the description
- Be concise and information-dense
- Never use marketing speak or AI-style language
- Be factual and direct

## Overview

JARITANET is an infrastructure-as-code monorepo using Pulumi. One `pulumi up` provisions a Hetzner VPS, installs k3s on it, reads the kubeconfig back as an output, and deploys everything into that cluster — Traefik for TLS (Let's Encrypt via DNS-01) and hostname routing, the web services, and the VPN transports. Cilium is the CNI, so NetworkPolicies are actually enforced. Cloudflare provides DNS only (no proxy/tunnel).


The same gateway also fronts a censorship-resistant VPN/proxy layer: Xray VLESS-REALITY and Hysteria2 share the VPS `:443`, optional edge boxes add entry points in other locations, and selectable exit nodes control egress IP. The sing-box client profile is generated and distributed by the same Pulumi run.

## Common Commands

### Development

- `mise run typecheck` - Type check every package
- `mise run test` - Run tests (vitest on Node — Pulumi needs Node's v8)
- `mise run lint` - Lint code with oxlint
- `mise run lint:fix` - Lint and auto-fix with oxlint
- `mise run fmt` - Format code with oxfmt
- `mise run fmt:check` - Check formatting with oxfmt
- `mise run preview` / `mise run up` - Wrap the Pulumi CLI. The credentials come from the stack, so both need a Pulumi login and nothing else. CI runs the same CLI directly.
- `mise run check` - Lint, format, typecheck and test. They are independent, so mise runs them in parallel and a failure stops only its dependents.
- `./packages/infra/src/update-apps.ts --dry-run` - Report which tracked components have moved, without writing or committing anything

### Git Hooks

The project uses Lefthook for pre-commit validation:

- Runs oxlint with auto-fix on staged files
- Runs oxfmt formatting on staged files
- Runs type checking before commit

Installed by the root `prepare` script, which no-ops when `CI` is set. Hooks
exist for a working tree a human is about to push; a runner has none, and the
workflow that does commit (`update-apps`) passes `-n` so a hook
that somehow exists cannot abort a run that already did its work.

### Package Management

- Uses [aube](https://aube.en.dev) as the package manager and script runner (pnpm-style isolated `node_modules`, reads `aube-lock.yaml`)
- Every package declares its own dependencies; the root holds only tooling
- Run commands from root directory
- Build-script allowlist and supply-chain defaults live in `aube-workspace.yaml`

## Architecture

### Where a thing lives

**`apps/<x>` is source this repository builds, and its chart lives with it** at
`apps/<x>/deploy/pulumi`. They are one project: the chart pins the app's own
version, they release together, and when an app leaves for its own repository
the chart is part of the directory that goes — which is exactly how mcp-gateway
and mariastew left.

**`packages/<x>` is deploy code for software built somewhere else**, whether
upstream (navidrome, Traefik, VictoriaMetrics, the transports) or another
repository of ours (blit) — plus the two shared primitives, `k8s` and `remote`.
Nothing here can be extracted, because there is nothing to extract it *to*.

### Packages

Components live in their own packages and know nothing about this deployment;
`packages/infra` is the only thing that knows what jaritanet is. Nothing imports
`infra`, and the only sideways imports are `@jaritanet/k8s` and
`@jaritanet/remote`, both of which are leaves.

- **`@jaritanet/k8s`** — Deployment/Service/PV/PVC templates and the primitives the others share (`ImageSchema`, `LimitsSchema`, `cpuRequests`, `sha256hex`)
- **`@jaritanet/remote`** — `remotePreamble`, the shell every `command.remote.Command` opens with: wait for cloud-init, then set a dpkg lock timeout apt honours on its own so the vendor installers inherit it. It has no dependencies and belongs to no cloud, which is what lets the `-systemd` transports and the k3s install share one copy without either depending on the other
- **`@jaritanet/vpn`** — the transports: Xray VLESS-REALITY, Hysteria2, tailnet relay, `unbound`, ss-rust exits, and the sing-box profile builder. Each has a DaemonSet form and a `-systemd` form; the latter takes an SSH connection and opaque `dependsOn`, so it works on any reachable box rather than one cloud's server type
- **`@jaritanet/hetzner`** — the VPS, its firewall rules, network tuning, k3s over SSH, Cilium as the CNI, the tailnet-rule DaemonSet that keeps Cilium's identity marks from tripping tailscaled's bypass routing (see docs/architecture.md), and the upgrade Plans that carry the k3s version to nodes Pulumi cannot reach
- **`@jaritanet/ingress`** — Traefik Helm chart, IngressRoute CRDs, and the redirect middleware
- **`@jaritanet/navidrome`**, **`@jaritanet/blit`** (and **`@jaritanet/files`**, which lives with its app) — a container, its volumes and its image pin. No configuration surface: 2Ti of media, a pinned uid and two volumes are facts about this deployment rather than knobs, and every one of them was already fixed in a config block nobody varied. What they take is only what the estate owns — where they are published, and which machine holds the disks
- **`@jaritanet/dns`** — Cloudflare A records, Fastmail MX/DKIM, Bluesky ATProto
- **`apps/auth/deploy/pulumi`** (`@jaritanet/auth`) — the login and consent provider Hydra delegates to, and a Redis holding one nonce per login in flight. Shares Hydra's hostname, split by path
- **`@jaritanet/mcp-gateway`** — OAuth-fronted gateway for self-hosted MCP servers (Hydra + Postgres)
- **`@jaritanet/metrics`** — VictoriaMetrics single-node, node-exporter and `vmagent` as DaemonSets, and Grafana signed in through the estate's own provider. Each agent scrapes its own node and remote-writes, rather than one scraper reaching across the tailnet to a residential uplink where a missed scrape is simply lost. Not kube-prometheus-stack: the operator, Alertmanager, kube-state-metrics and ~30 CRDs are monitoring outweighing the monitored on the box whose scheduler already refused a transport for lack of CPU
- **`apps/serve-from-env/deploy/pulumi`** (`@jaritanet/serve-from-env`) — a Secret of path → body, a Deployment serving exactly those paths, and the annotation that restarts it when the table changes. The caller keeps what the table *means*; this knows only that it is JSON
- **Extracted, and consumed as published packages** — `@radiosilence/mcp-gateway-pulumi` and `@radiosilence/mariastew-pulumi`. Each is published by the repository that builds the app, at that app's own version, so pinning the package says exactly which build runs and what image that is stops being this repository's business
- **`packages/infra`** — this stack. `main.ts` orchestrates, `stack.ts` says what jaritanet is, `services.ts` builds everything in the cluster and publishes it, `secrets.ts` is the only reader of stack config, `gateway.ts` and `edge.ts` compose a Hetzner box with transports on it, and `schemas.ts` holds the shapes that exist only because they are composed. `checkout.ts` warns when the deploy is not running from a clean, current `main`: the plan is whatever the tree contains, so a branch that is behind reverts what main has and it lacks, which twice nearly downgraded mariastew as an incidental line in an unrelated diff

Packages are `private` and imported as TypeScript source — Node resolves a
workspace symlink to its real path, which is outside `node_modules`, so type
stripping applies and the deploy needs no build step. Publishing them is what
the version and `exports` fields are for; it needs a `tsc` emit and
`@pulumi/pulumi` moved to a peer dependency first.

### Single Pulumi Stack

Everything still deploys in one `pulumi up` from `packages/infra/`.

### The stack is TypeScript; config is a credential store

**`Pulumi.main.yaml` holds secrets, and nothing else.** What jaritanet *is*
lives in `infra/src/stack.ts` and `infra/src/services.ts` as ordinary
TypeScript. `packages/infra` is the instance, not the class, so it can simply
say what it runs — and the compiler checks the shape, the editor completes it,
and a value needed twice is one binding rather than two entries that can drift.
`infra/src/secrets.ts` is the only thing that reads stack config.

**Every service is a function call.** There is no `services` map and no `kind`
union; that union existed only so data could select a constructor, which is what
a program does by calling one. What every service shares — an address, and
possibly an OAuth client — is derived once in `services.ts` from what each
constructor returns, so publishing and client registration are still written in
one place rather than per service. That matters most for the redirect
allowlist: it is what stands between the identity provider and an open
redirect, and a service builds its redirect URI from the same binding it
publishes at, so the two cannot disagree.

**A package per deployable unit.** navidrome, files and blit are packages like
everything else — the answer to "should X be a package" is now yes, uniformly,
because a package is where a thing's deploy shape and its image pin belong
together. What a package does *not* hold is its own address.

**The schemas survive as a defaults-and-invariants layer, not a parser.** Each
constructor takes `z.input<Schema>` and parses its own arguments, so a call site
states only what it differs on and thirty defaults stay stated once. TypeScript
describes shapes; Zod is kept for the relationships a type cannot express —
that `k3s.version` and `k3s.ciliumVersion` are a tested pair, that no two
REALITY server names share a first label.

`mise run check:profiles` runs the **real** sing-box binary (pinned to the oldest core the fleet is on, `MIN_CORE` in the script) over every profile shape via docker `check`. That is the only test that answers "will the devices accept this" — a schema cannot, since the published one is always the latest. Skips silently without a docker daemon.

`schemas/sing-box.json` is different: it is sing-box's own published schema, vendored (`curl -o schemas/sing-box.json https://sing-box.sagernet.org/schema.json`) so `singbox.schema.test.ts` can validate every generated profile offline. A profile that fails to parse fails on every device at once, so this check belongs in CI rather than on the fleet.

### Service Flow

External traffic follows this path:
`https://hostname` -> gateway VPS -> Xray `:443` -> Traefik hostPort (TLS + routing) -> service

Without a gateway, Traefik serves directly via hostPort 443 and DNS points at the server's detected external IP.

### Identity

Ory Hydra is the authorization server and is headless: it delegates "who is this
person" and "do they consent" to whatever `URLS_LOGIN` and `URLS_CONSENT` point
at. Those pointed into mcp-gateway, which made mcp-gateway the login screen for
every client of that Hydra — invisible while it was the only one, and visible
the moment a second arrived. An unhealthy replica returning 502 on
`hydra get_consent` was intermittent login failures on `mariastew`, which has
nothing else to do with it.

`@jaritanet/auth` is now that provider and only that. It never learns which
application is being signed in to — Hydra carries that in the challenge and
redirects the browser to whichever client began the flow — so one instance
serves every relying party and adding one requires nothing at GitHub.

**One hostname, split by path.** Hydra keeps `/oauth2/*`, `/.well-known/*` and
`/userinfo` on the bare `Host()` rule; auth claims `/auth/*`, `/register`,
`/healthz`, `/` and `/assets/*` at a higher priority. `URLS_SELF_ISSUER` already
stood there, so which hostname issues tokens did not change — only which service
answers the challenges. Hydra itself is still deployed by the mcp-gateway kind,
because moving it would move the database holding every registered client.

**The allowlist is the gate, and an empty one refuses to boot.** Dynamic client
registration cannot be closed — Claude registers its own client — so a
registered client is assumed hostile. What makes that safe is that a client is
useless without a token and a token issues only to a login in `auth.github.allowed`.

**Every relying party gets an address, and both halves have to agree.** The
scope is `read:user user:email` and the claim comes from the primary *verified*
entry in `/user/emails` — `read:user` alone returns the public profile address,
which is usually null. `email` is in the client registration's default scopes as
well, because Hydra grants only what a client is registered for: a service asking
for a scope its registration lacks is refused with `invalid_scope`, which Grafana
reports as the provider denying the request, naming neither the scope nor the
claim. Grafana is what forced this — it refuses a login carrying no address at
all — but a bare `sub` was showing `github:12345` everywhere else too.

**The session is Hydra's.** Logins are accepted with `remember`, carrying the
upstream login in the session context, so signing in to a second service skips
GitHub entirely and restarting the provider logs nobody out. That is also why it
holds no session store: a Redis with no volume, carrying one ten-minute CSRF
nonce per login in flight, is the whole of its state.

**Registration is derived, not declared.** A service says only *that* it needs
auth — `oidc: { clientId, issuer }` — and `relyingParties()` in
`infra/src/services.ts` turns that into a client whose redirect URI comes from
the hostname the service already publishes and whose secret the stack generates.
That is a security control rather than tidiness: the redirect allowlist is what
stands between the provider and an open redirect, so a generated list cannot
hold a typo, cannot keep an entry for a service that moved, and gives no service
a way to widen its own permissions. Exact matches only — a wildcard on a
hostname is how one forgotten subdomain becomes a token thief.

Each secret is generated once in `main.ts` and handed to both halves, so the
provider registering the client and the service authenticating with it cannot
disagree. That replaced mariastew's `mariastew-register-client` Job, which had
the service minting its own credential and posting it to Hydra's admin API —
each relying party knowing how identity works is the thing being removed.

### Key Components

- **Hysteria2** — QUIC/UDP transport with Salamander obfuscation; the fast, loss-tolerant daily-driver entry, on the gateway and every edge. Listens on `:443` plus `altPorts` (3478 STUN, 4500 IPsec NAT-T) as one process per port, because inspecting middleboxes block QUIC on 443 and VoIP-blocking regimes block 3478 — the client's urltest finds whichever survives. Admin-only: auth is a per-admin `userpass` map (guests get reality only), obfs is server-wide; both delivered inside admin sing-box profiles.
- **Xray (optional)** — When `gateway.xray` is set, Xray-core takes the VPS `:443` (VLESS-Vision-REALITY) and Traefik's https bind moves to local `:8443`. Traffic that doesn't match a client is relayed to `dest` (Traefik's `:8443`); matched clients are proxied out. One REALITY UUID per VPN user (`email: <name>`), delivered inside that user's sing-box profile (see RBAC). `serverNames` is a list, and deliberately contains none of our hostnames — content filters pick what to TLS-intercept from the SNI's reputation category, and a mis-rated own-domain gets every handshake forged. The client carries one outbound per name in its urltest, so no single borrowed identity being blocked (google in China, an adult mis-rating in a pub) is fatal (see docs/architecture.md, Hardening notes).
- **sing-box delivery** — `@jaritanet/vpn` aggregates the primary + every edge into a per-user client profile (`buildProfile`, role-aware), writes each to the file server over SSH (content-hashed, so unchanged deploys are silent), sweeps superseded slug files so rotated profile URLs 404 rather than serving stale credentials, and notifies Telegram with every user's URL on change. The notify script is piped to node over stdin rather than named as a file, because every input of a `local.Command` is a trigger and an absolute path made the checkout's location part of the resource — a deploy from a worktree announced a credential rotation that had not happened. It must therefore stay self-contained: a relative import has nothing to resolve against.
- **Traefik** — Ingress controller with built-in ACME. Handles Let's Encrypt certs via DNS-01 challenge against Cloudflare. Always binds hostPort 443 as fallback. Its Prometheus endpoint carries the router, service and entrypoint labels, which is the difference between per-route rates and one number for the whole estate.
- **Metrics** — Grafana opens on a triage page rather than on its own onboarding: the worst disk, the worst container, anything unmeasured, and the nearest certificate expiry, each coloured and named. Anything summed per pod excludes `container=""` — cAdvisor reports the pod-level cgroup alongside its containers under the same `pod` label, so a naive `sum by (pod)` reads double. Cilium exports its own counters and Hubble's flow metrics alongside, including `hubble_drop_total{reason="POLICY_DENIED"}` — the NetworkPolicies in this repo were decorative under flannel and are enforced under Cilium, and that counter is how the difference stops being a belief. Both metrics servers sit on the same hostNetwork agent pod, so they are scraped as static targets on the node rather than discovered from a `prometheus.io/port` annotation that can only name one of them.
- **Cloudflare** — DNS only. A records pointing at VPS or server IP, plus Fastmail MX/DKIM and Bluesky ATProto records.
- **Gateway** — Hetzner. `gateway.hcloudToken` and `gateway.k3s` are both required: the box provides the cluster.
- **Transports in the cluster** — with `gateway.k3s` the cluster runs on the gateway, so xray, hysteria, tailscale and unbound are DaemonSets there rather than systemd units installed over SSH. All four are `hostNetwork` (they must own the host's real ports, see real client addresses, and treat `127.0.0.1` as the host's loopback), which is also why a DaemonSet: two replicas can never share a node, so "one per matching node" is the shape rather than something an update strategy has to work around. They select on the `jaritanet.radiosilence.dev/vpn-entry` node label (from `vpnEntryLabel`, read once and passed to both the labeller and every nodeSelector as a required argument, so they cannot drift apart), so which machine serves an entry is a property of that machine — `lady` joining the cluster does not make it a VPN entry. Their keys and passwords are Pulumi-held rather than minted on the box: an on-box secret cannot follow a rescheduled pod, and reading one back over SSH is the coupling the move exists to remove. The `-systemd` variants stay for the edges, and `gateway-legacy-units` uninstalls whatever a pre-cluster deploy left on the box, since a stopped daemon is one package upgrade away from taking a port back.
- **k3s upgrades** — Rancher's system-upgrade-controller, deployed from its pinned release manifests, plus a server Plan and an agent Plan both reading `k3s.version`. Reach comes from cluster membership rather than a route to the box, which is the only thing that works for a node joined from a cloud-init seed: Pulumi never created it, holds no key for it and has no address for it, so break-glass SSH does not help either. The server Plan cordons rather than drains — the gateway is the only server, so a drain would evict the cluster to nowhere — and agents drain, which leaves the DaemonSet transports running. `k3s.version` and `k3s.ciliumVersion` reach the fleet by separate paths (Plan vs Helm) and must pair, so `CILIUM_K8S_SUPPORT` in `@jaritanet/hetzner` encodes Cilium's tested Kubernetes ranges and `K3sConfSchema` fails to parse a half-bump — a red preview instead of a cluster that comes up healthy and moves no packets.

## GitHub Actions

### CI/CD (`ci-cd.yml`)

Triggered on pushes and pull requests affecting package files, manually via `workflow_dispatch`, or as a reusable workflow (`workflow_call`, with the Pulumi/Cloudflare/Hetzner secrets):

1. **Test** - Type checks, lints, runs vitest suite
2. **Deploy** (main branch only) - a single `pulumi up` deploying everything

### Preview (`preview.yml`)

Runs `pulumi preview --refresh` on infra PRs and posts the diff as a PR comment — read-only, surfaces resource **replacements** (e.g. the gateway VPS) before merge. The refresh is what makes it call the cloud APIs, so a credential revoked since the last deploy fails here rather than mid-deploy.

Both verbs enter `packages/infra/src/deploy.ts` (Pulumi Automation API), which applies stack config from the environment and then previews or updates. Sharing an entrypoint is the point: a preview produced by different machinery than the deploy predicts nothing. Config is written to the checked-out `Pulumi.main.yaml` rather than the shared stack, so one PR's injected hostnames never reach another's preview.

### App Version Updates (`update-apps.yml`)

Daily check for new releases of the components listed in `.github/tracked-versions.yml`. Uses a GitHub App token so version bump commits trigger the CI/CD pipeline.

The workflow only supplies tokens; the work is `packages/infra/src/update-apps.ts`, with the decisions it makes — tag normalisation, image reference parsing, and whether an entry moved — isolated in `versions.ts` where they are unit tested. A release tag is never trusted on its own: the registry is asked whether the image actually published, including for entries already up to date, so a pin that stopped resolving is reported rather than waiting for the next pod restart to find it.

A missing image fails the run only when it is the *pinned* one — that is a live deployment referencing something that no longer exists. A newer release whose image has not published yet warns and leaves the entry alone: several upstreams build their container separately from the release it tracks, so lag is their normal operation and there is nothing here to act on. Failing on it left the workflow permanently red, which costs the alarm rather than fixing anything.

Rewrites go through the YAML document API and mutate the existing scalar, so a bump changes exactly one line and leaves comments and quoting alone.

### Container Builds (`build-*-container.yml`)

Builds and publishes each container on changes to its own directory, one job per
architecture on a runner of that architecture (via `blit-workflows`) rather than
emulating arm64 under QEMU.

Each Rust one carries a `check` job — fmt, clippy, `cargo test` — which the
publish depends on, so no image is built from code that does not pass. It gates
the publish and not the compile: the compile is the long pole, so it starts at
once and the check runs beside it, where putting it in front would add the
check to the critical path of every green run to save a compile on a red one.

It lives here rather than in `ci-cd.yml` because that is what makes it fire on
the crate's own path filter — as a matrix job in the infra pipeline it
recompiled all three crates for a change that touched no Rust, and gated
nothing. The toolchains differ on purpose: `check` takes the floating
`rust = "1"` from `mise.toml`, where a compiler bump breaking is the point,
while the compile pins the version that ships.

**Where the compile happens is the difference between the two Rust shapes.** A
`cargo build` inside a Dockerfile is one atomic layer, so a single crate moving
in `Cargo.lock` recompiles all of them — measured on `mariastew` at 168s of
dependencies against 15s of its own code. Neither the stub-`main` layer nor
`cargo-chef` subdivides that; they reorder it. Cargo's own cache does have the
right granularity, and the only place it survives between runs is the runner, so
`auth` compiles there under `Swatinem/rust-cache` and hands the
binary to `build-publish-container.yml` as an artefact (`context-artifact`),
leaving its Dockerfile a `COPY` into a base image. The price is that it no
longer builds from a bare checkout. mariastew does the same in its own
repository. `serve-from-env` still
compiles inline at 46 crates, where a second job shape costs more than it saves.

Caches are written from `main` only (`save-if`). A branch's cache is invisible
to every other branch and still evicts from the repository's 10GB, which is how
`main` ends up cold — the one state this is all meant to avoid.

Our containers are versioned and released from here, so the updater can track
them like any upstream. The version lives in each app's `Cargo.toml`, or
`apps/files/VERSION`; changing it is the release. CI publishes the image, cuts
`<app>-v<version>`, and the updater moves the pin. Tags are output, not input —
nothing reads one to decide what to build. Several containers releasing from one
repo is why tracked entries need `tagPrefix`: "the latest release" is otherwise
repo-wide.

## Container Services

- `apps/files/` - Nginx-based file server with CORS and compression
- `apps/serve-from-env/` - Serves `$ROUTES` (`{"<path>": <content>}`) and
  nothing else; static musl binary on `scratch`. Built for the sing-box
  profiles, whose paths are secret and whose bodies Pulumi already holds as
  strings — so there is no volume to mount and no file to go stale.
- `apps/mariastew/` - Torrent web UI fronting aria2; see `apps/mariastew/README.md`
- `apps/auth/` - Hydra's login and consent provider; see `apps/auth/README.md`

## Utility Scripts

- **`scripts/k3s-node-token`** - Prints the k3s join token, read off the control-plane node through the API. The token exists only on that box and nothing in the stack reads it back, so a privileged pod is the way in until SSH exists
- **`scripts/make-seed-drive`** - Builds the cloud-init seed drive that provisions a bare-metal node. A node is flashed with Ubuntu's cloud image directly rather than booted from an installer, which avoids betting on the boot order and BIOS password of a second-hand machine; the config arrives separately on a FAT32 volume labelled `CIDATA`, because macOS cannot write the image's ext4 root
- **`scripts/lima-node`** - Joins a throwaway Lima VM to the cluster as a k3s agent, on the tailnet so the control plane can reach its kubelet back. Exercises the agent join path without hardware

## Development Notes

- Single package at `packages/infra/` with its own `tsconfig.json` and `package.json`
- **Use aube for package management and script running** — node 24 provides the runtime
- Type checking must pass before commits (Lefthook)
- oxlint handles linting, oxfmt handles code formatting
- The system runs on minimal hardware (2014 MacBook Pro)
- No inbound ports on the home network — the home node joins the cluster outbound, over the tailnet
- Tailscale provides secure access to internal Kubernetes cluster for CI/CD
- Secrets managed through GitHub repository secrets and Pulumi configuration
