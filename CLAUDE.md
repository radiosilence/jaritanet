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
- `./scripts/gen-schemas.ts` - Generate JSON schemas from Zod definitions
- `mise run lint` - Lint code with oxlint
- `mise run lint:fix` - Lint and auto-fix with oxlint
- `mise run fmt` - Format code with oxfmt
- `mise run fmt:check` - Check formatting with oxfmt
- `mise run preview` / `mise run up` - Wrap the Pulumi CLI. Config comes from the stack, credentials included, so both need a Pulumi login and nothing else. CI runs the same CLI directly.
- `mise run check` - Lint, format, typecheck and test. They are independent, so mise runs them in parallel and a failure stops only its dependents.
- `./packages/infra/src/update-apps.ts --dry-run` - Report which tracked components have moved, without writing or committing anything

### Git Hooks

The project uses Lefthook for pre-commit validation:

- Runs oxlint with auto-fix on staged files
- Runs oxfmt formatting on staged files
- Runs type checking before commit

### Package Management

- Uses [aube](https://aube.en.dev) as the package manager and script runner (pnpm-style isolated `node_modules`, reads `aube-lock.yaml`)
- Every package declares its own dependencies; the root holds only tooling
- Run commands from root directory
- Build-script allowlist and supply-chain defaults live in `aube-workspace.yaml`

## Architecture

### Packages

Components live in their own packages and know nothing about this deployment;
`packages/infra` is the only thing that knows what jaritanet is. Nothing imports
`infra`, and nothing imports sideways except from `@jaritanet/k8s`.

- **`@jaritanet/k8s`** — Deployment/Service/PV/PVC templates and the primitives the others share (`ImageSchema`, `LimitsSchema`, `cpuRequests`, `sha256hex`)
- **`@jaritanet/vpn`** — the transports: Xray VLESS-REALITY, Hysteria2, tailnet relay, `unbound`, ss-rust exits, and the sing-box profile builder. Each has a DaemonSet form and a `-systemd` form; the latter takes an SSH connection and opaque `dependsOn`, so it works on any reachable box rather than one cloud's server type
- **`@jaritanet/hetzner`** — the VPS, its firewall rules, network tuning, k3s over SSH, Cilium as the CNI, the tailnet-rule DaemonSet that keeps Cilium's identity marks from tripping tailscaled's bypass routing (see docs/architecture.md), and the upgrade Plans that carry the k3s version to nodes Pulumi cannot reach
- **`@jaritanet/ingress`** — Traefik Helm chart, IngressRoute CRDs, and the redirect middleware
- **`@jaritanet/dns`** — Cloudflare A records, Fastmail MX/DKIM, Bluesky ATProto
- **`@jaritanet/mcp-gateway`** — OAuth-fronted gateway for self-hosted MCP servers (Hydra + Postgres)
- **`@jaritanet/mariastew`** — torrent web UI fronting aria2, OIDC-gated against the estate's Hydra. One pod, two containers sharing a network namespace, built from the same image, so aria2's RPC never leaves loopback and needs no credential of its own
- **`packages/infra`** — this stack. `main.ts` orchestrates, `gateway.ts` and `edge.ts` compose a Hetzner box with transports on it, `conf.schemas.ts` assembles the config surface from the component schemas, and `conf.ts` parses the whole config surface, secrets included, in one pass

Packages are `private` and imported as TypeScript source — Node resolves a
workspace symlink to its real path, which is outside `node_modules`, so type
stripping applies and the deploy needs no build step. Publishing them is what
the version and `exports` fields are for; it needs a `tsc` emit and
`@pulumi/pulumi` moved to a peer dependency first.

### Single Pulumi Stack

Everything still deploys in one `pulumi up` from `packages/infra/`.

### Configuration System

All config uses Zod V4 schemas for runtime validation. Configuration lives in `Pulumi.main.yaml`. A component's schema lives with the component; `infra/src/conf.schemas.ts` re-exports them alongside the composed shapes (`GatewayConfSchema`, `EdgeConfSchema`) so the stack's config surface is described in one place, and regenerates via the gen-schemas script.

**What is top-level and what is a service.** If it is a workload, it goes in `services` and declares a `kind`; what stays above is the part that is not one — accounts and DNS facts (`cloudflare`, `zones`, `tailnet`, `fastmail`, `bluesky`, `telegram`), machines (`gateway`, `edges`, `exits`), and `traefik`, which cannot be a service because it is the thing that publishes them. That rule is what replaced the `mcpGateway`, `home` and `profiles` top-level blocks, each of which carried its own copy of "find the zone, make an A record, make an IngressRoute"; publishing now happens once, in `infra/src/services.ts`, driven by whatever routes a kind returns. `telegram` moved up from a single service's config once it gained a second consumer (the sing-box profile server and mariastew both notify through it) — a value read by more than one workload is an account, not a setting that belongs to either.

A `kind` exists only for behaviour config cannot express — rendering `smb.conf`, standing up Hydra and Postgres, hashing a routing table into a pod annotation. Anything that is just a container with disks is `kind: web` and needs no module: navidrome is 2Ti of media, a pinned uid and two volumes, and has never had one. That is why composition stops at a tagged union rather than growing into a hierarchy, and why the answer to "should X be a module" is usually no.

Config schemas are **strict**. `nodeSelector` sat in two service blocks for months doing nothing, because Zod strips unknown keys in silence and the generated JSON schema permitted them — it read as pinning to `lady` while the pinning actually came from `nodeAffinityHostname` on the volumes. A key nobody reads now fails the preview.

`mise run check:profiles` runs the **real** sing-box binary (pinned to the oldest core the fleet is on, `MIN_CORE` in the script) over every profile shape via docker `check`. That is the only test that answers "will the devices accept this" — a schema cannot, since the published one is always the latest. Skips silently without a docker daemon.

`schemas/sing-box.json` is different: it is sing-box's own published schema, vendored (`curl -o schemas/sing-box.json https://sing-box.sagernet.org/schema.json`) so `singbox.schema.test.ts` can validate every generated profile offline. A profile that fails to parse fails on every device at once, so this check belongs in CI rather than on the fleet.

### Service Flow

External traffic follows this path:
`https://hostname` -> gateway VPS -> Xray `:443` -> Traefik hostPort (TLS + routing) -> service

Without a gateway, Traefik serves directly via hostPort 443 and DNS points at the server's detected external IP.

### Key Components

- **Hysteria2** — QUIC/UDP transport with Salamander obfuscation; the fast, loss-tolerant daily-driver entry, on the gateway and every edge. Listens on `:443` plus `altPorts` (3478 STUN, 4500 IPsec NAT-T) as one process per port, because inspecting middleboxes block QUIC on 443 and VoIP-blocking regimes block 3478 — the client's urltest finds whichever survives. Admin-only: auth is a per-admin `userpass` map (guests get reality only), obfs is server-wide; both delivered inside admin sing-box profiles.
- **Xray (optional)** — When `gateway.xray` is set, Xray-core takes the VPS `:443` (VLESS-Vision-REALITY) and Traefik's https bind moves to local `:8443`. Traffic that doesn't match a client is relayed to `dest` (Traefik's `:8443`); matched clients are proxied out. One REALITY UUID per VPN user (`email: <name>`), delivered inside that user's sing-box profile (see RBAC). `serverNames` is a list, and deliberately contains none of our hostnames — content filters pick what to TLS-intercept from the SNI's reputation category, and a mis-rated own-domain gets every handshake forged. The client carries one outbound per name in its urltest, so no single borrowed identity being blocked (google in China, an adult mis-rating in a pub) is fatal (see docs/architecture.md, Hardening notes).
- **sing-box delivery** — `@jaritanet/vpn` aggregates the primary + every edge into a per-user client profile (`buildProfile`, role-aware), writes each to the file server over SSH (content-hashed, so unchanged deploys are silent), sweeps superseded slug files so rotated profile URLs 404 rather than serving stale credentials, and notifies Telegram with every user's URL on change.
- **Traefik** — Ingress controller with built-in ACME. Handles Let's Encrypt certs via DNS-01 challenge against Cloudflare. Always binds hostPort 443 as fallback.
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

### Schema Generation (`generate-schemas.yml`)

Generates JSON schemas from Zod definitions on changes or daily schedule. Commits with `[skip ci]` tag.

### App Version Updates (`update-apps.yml`)

Daily check for new releases of the components listed in `.github/tracked-versions.yml`. Uses a GitHub App token so version bump commits trigger the CI/CD pipeline.

The workflow only supplies tokens; the work is `packages/infra/src/update-apps.ts`, with the decisions it makes — tag normalisation, image reference parsing, and whether an entry moved — isolated in `versions.ts` where they are unit tested. A release tag is never trusted on its own: the registry is asked whether the image actually published, including for entries already up to date, so a pin that stopped resolving is reported rather than waiting for the next pod restart to find it.

A missing image fails the run only when it is the *pinned* one — that is a live deployment referencing something that no longer exists. A newer release whose image has not published yet warns and leaves the entry alone: several upstreams build their container separately from the release it tracks, so lag is their normal operation and there is nothing here to act on. Failing on it left the workflow permanently red, which costs the alarm rather than fixing anything.

Rewrites go through the YAML document API and mutate the existing scalar, so a bump changes exactly one line and leaves comments and quoting alone.

### Container Builds (`build-files-container.yml`, `build-serve-from-env-container.yml`)

Builds and publishes each container on changes to its own directory, one job per
architecture on a runner of that architecture (via `blit-workflows`) rather than
emulating arm64 under QEMU. The Rust one is also checked by the `containers` job
in `ci-cd.yml` (fmt, clippy, `cargo test`).

Our containers are versioned and released from here, so the updater can track
them like any upstream. The version lives in `apps/serve-from-env/Cargo.toml`
and `apps/files/VERSION`; changing it is the release. CI publishes the
image, cuts `serve-from-env-v<version>` / `files-v<version>`, and the updater
moves the pin. Tags are output, not input — nothing reads one to decide what to
build. Both containers releasing from one repo is why tracked entries need
`tagPrefix`: "the latest release" is otherwise repo-wide.

## Container Services

- `apps/files/` - Nginx-based file server with CORS and compression
- `apps/serve-from-env/` - Serves `$ROUTES` (`{"<path>": <content>}`) and
  nothing else; static musl binary on `scratch`. Built for the sing-box
  profiles, whose paths are secret and whose bodies Pulumi already holds as
  strings — so there is no volume to mount and no file to go stale.
- `apps/mariastew/` - Torrent web UI fronting aria2; see `apps/mariastew/README.md`

## Utility Scripts

- **`scripts/gen-schemas.ts`** - Converts Zod schemas to JSON Schema format
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
