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

JARITANET is an infrastructure-as-code monorepo using Pulumi to expose Kubernetes services via a Hetzner VPS gateway. Rathole tunnels TCP from the VPS to an in-cluster Traefik instance that handles TLS termination (Let's Encrypt via DNS-01) and hostname routing. Cloudflare provides DNS only (no proxy/tunnel).

The same gateway also fronts a censorship-resistant VPN/proxy layer: Xray VLESS-REALITY and Hysteria2 share the VPS `:443`, optional edge boxes add entry points in other locations, and selectable exit nodes control egress IP. The sing-box client profile is generated and distributed by the same Pulumi run.

## Common Commands

### Development

- `aube run typecheck:infra` - Type check infrastructure package
- `aube run test` - Run tests (vitest on Node — Pulumi needs Node's v8)
- `./scripts/gen-schemas.ts` - Generate JSON schemas from Zod definitions
- `aube run lint` - Lint code with oxlint
- `aube run lint:fix` - Lint and auto-fix with oxlint
- `aube run fmt` - Format code with oxfmt
- `aube run fmt:check` - Check formatting with oxfmt
- `aube run preview` / `aube run deploy` - Drive the stack through `src/deploy.ts`, the same entrypoint CI uses. Both rewrite the local `Pulumi.main.yaml` from the environment first, so run them with CI's secrets or not at all.
- `./packages/infra/src/update-apps.ts --dry-run` - Report which tracked components have moved, without writing or committing anything

### Git Hooks

The project uses Lefthook for pre-commit validation:

- Runs oxlint with auto-fix on staged files
- Runs oxfmt formatting on staged files
- Runs type checking before commit

### Package Management

- Uses [aube](https://aube.en.dev) as the package manager and script runner (pnpm-style isolated `node_modules`, reads `aube-lock.yaml`)
- Workspace-based monorepo with shared dependencies
- Run commands from root directory
- Build-script allowlist and supply-chain defaults live in `aube-workspace.yaml`

## Architecture

### Single Pulumi Stack

Everything deploys in one `pulumi up` from `packages/infra/`:

- **`src/modules/gateway.ts`** — Hetzner VPS + firewall + Rathole server; hosts the entry transports and the gateway `unbound` DNS cache
- **`src/modules/hysteria.ts`** — Hysteria2 (QUIC/UDP) transport with Salamander obfuscation, on the gateway + edges
- **`src/modules/xray.ts`** — optional Xray VLESS-REALITY (TCP), sharing :443 with rathole on the gateway
- **`src/modules/ingress.ts`** — Traefik Helm chart, Rathole client, IngressRoute CRDs, IP watcher
- **`src/modules/edge.ts`** — standalone VPN edge boxes (hy2 + REALITY + tailnet relay, no rathole/proxy)
- **`src/modules/exit.ts`** — in-cluster ss-rust egress nodes, reached through the rathole tunnel (deterministic loopback ports)
- **`src/modules/tailscale.ts`** — joins the gateway/edges to the tailnet as a relay (`--accept-routes=false` is load-bearing)
- **`src/modules/singbox.ts`** — builds the sing-box client profile from all nodes and delivers it to the file server (SSH, content-hashed, Telegram notify)
- **`src/modules/dns.ts`** — Cloudflare A records, Fastmail MX/DKIM, Bluesky ATProto
- **`src/templates/service.ts`** — K8s Deployment/Service/PV/PVC templates (schemas + tests alongside)
- **`src/main.ts`** — Orchestrates all modules
- **`src/conf.ts`** / **`src/conf.schemas.ts`** — Unified Zod config schema

### Configuration System

All config uses Zod V4 schemas for runtime validation. Configuration lives in `Pulumi.main.yaml`. Schema definitions in `*.schemas.ts` files, regenerated via gen-schemas script.

### Service Flow

External traffic follows this path:
`https://hostname` -> Gateway VPS (Rathole) -> K8s cluster (Rathole client) -> Traefik (TLS + routing) -> service

Without a gateway, Traefik serves directly via hostPort 443 and DNS points at the server's detected external IP.

### Key Components

- **Rathole** — Rust-based TCP tunnel. Server on VPS, client in K8s. Stateless relay, no TLS/routing knowledge.
- **Hysteria2** — QUIC/UDP transport with Salamander obfuscation; the fast, loss-tolerant daily-driver entry, on the gateway and every edge. Listens on `:443` plus `altPorts` (3478 STUN, 4500 IPsec NAT-T) as separate `hysteria-server@` instances, because inspecting middleboxes block QUIC on 443 and VoIP-blocking regimes block 3478 — the client's urltest finds whichever survives. Admin-only: auth is a per-admin `userpass` map (guests get reality only), obfs is server-wide; both minted on-box and delivered inside admin sing-box profiles.
- **Xray (optional)** — When `gateway.xray` is set, Xray-core takes the VPS `:443` (VLESS-Vision-REALITY) and rathole's https bind moves to local `:8443`. Traffic that doesn't match a client is relayed to `dest` (rathole → Traefik); matched clients are proxied out. The keypair is minted on-box and never leaves it; one REALITY UUID is minted per VPN user (`email: <name>`) and delivered inside each user's sing-box profile (see RBAC). `serverNames` is a list, and deliberately contains none of our hostnames — content filters pick what to TLS-intercept from the SNI's reputation category, and a mis-rated own-domain gets every handshake forged. The client carries one outbound per name in its urltest, so no single borrowed identity being blocked (google in China, an adult mis-rating in a pub) is fatal (see docs/architecture.md, Hardening notes).
- **sing-box delivery** — `singbox.ts` aggregates the primary + every edge into a per-user client profile (`buildProfile`, role-aware), writes each to the file server over SSH (content-hashed, so unchanged deploys are silent), sweeps superseded slug files so rotated profile URLs 404 rather than serving stale credentials, and notifies Telegram with every user's URL on change.
- **Traefik** — Ingress controller with built-in ACME. Handles Let's Encrypt certs via DNS-01 challenge against Cloudflare. Always binds hostPort 443 as fallback.
- **Cloudflare** — DNS only. A records pointing at VPS or server IP, plus Fastmail MX/DKIM and Bluesky ATProto records.
- **IP watcher** — Pod that checks external IP every 60s via Cloudflare's 1.1.1.1/cdn-cgi/trace and triggers deploy on change.
- **Gateway** — Hetzner (HCLOUD_TOKEN) when set, else direct mode.

## GitHub Actions

### CI/CD (`ci-cd.yml`)

Triggered on pushes and pull requests affecting package files, manually via `workflow_dispatch`, or as a reusable workflow (`workflow_call`, with the Pulumi/Cloudflare/Hetzner secrets):

1. **Test** - Type checks, lints, runs vitest suite
2. **Deploy** (main branch only) - `aube run deploy`, a single `pulumi up` deploying everything

### Preview (`preview.yml`)

Runs `aube run preview` on infra PRs and posts the diff as a PR comment — read-only, surfaces resource **replacements** (e.g. the gateway VPS) before merge.

Both verbs enter `packages/infra/src/deploy.ts` (Pulumi Automation API), which applies stack config from the environment and then previews or updates. Sharing an entrypoint is the point: a preview produced by different machinery than the deploy predicts nothing. Config is written to the checked-out `Pulumi.main.yaml` rather than the shared stack, so one PR's injected hostnames never reach another's preview.

### Schema Generation (`generate-schemas.yml`)

Generates JSON schemas from Zod definitions on changes or daily schedule. Commits with `[skip ci]` tag.

### App Version Updates (`update-apps.yml`)

Daily check for new releases of the components listed in `.github/tracked-versions.yml`. Uses a GitHub App token so version bump commits trigger the CI/CD pipeline.

The workflow only supplies tokens; the work is `packages/infra/src/update-apps.ts`, with the decisions it makes — tag normalisation, image reference parsing, and whether an entry moved — isolated in `versions.ts` where they are unit tested. A release tag is never trusted on its own: the registry is asked whether the image actually published, including for entries already up to date, so a pin that stopped resolving is reported rather than waiting for the next pod restart to find it.

Rewrites go through the YAML document API and mutate the existing scalar, so a bump changes exactly one line and leaves comments and quoting alone.

### Ansible Deployment (`run-playbook.yml`)

Triggered on ansible/ changes. Connects via Tailscale, runs playbooks, updates GitHub secrets. Roles are tagged with their own name; the workflow diffs the push and runs only the changed roles (`--tags`), falling back to a full run on shared-file changes. `workflow_dispatch` takes a `tags` input for targeted manual runs. CI runs use the Mitogen strategy (env-only) for speed.

### Container Builds (`build-files-container.yml`)

Builds and publishes the file server container on changes to `containers/files/`.

## Ansible Infrastructure

Server provisioning and configuration:

### Playbook Structure (`playbook.yml`)

Three-stage deployment targeting different host groups:

1. **Common Configuration** (`hosts: all`)
   - Base system setup, user management, SSH hardening
   - Tool installation (helix, mise, zsh, btop, broot)

2. **Homeserver Configuration** (`hosts: homeservers`)
   - MicroK8s cluster setup with configurable addons
   - NFS and Samba file sharing
   - Syncthing for file synchronization
   - Media downloader services (yt-dlp, get-iplayer)

3. **Tailnet Integration** (`hosts: tailnet`)
   - Tailscale VPN connectivity

### Ansible Roles

- **`common/`** - System updates, package installation, SSH hardening
- **`microk8s/`** - K8s cluster, addons (from config), service accounts, kubeconfig generation
- **`users/`** - User accounts and SSH key management
- **`github/`** - GitHub CLI and authentication setup
- **`tailscale/`** - VPN mesh network connectivity
- **`nfs/`** - Network file system exports
- **`samba/`** - SMB file sharing
- **`syncthing/`** - P2P file sync service
- **`downloader/`** - Media download tools (yt-dlp, get-iplayer, aria2)
- **`helix/`** - Helix editor installation
- **`mise/`** - Tool version manager installation

### Configuration

- `group_vars/all.yml` - Global variables (username, tailscale settings)
- `group_vars/homeservers.yml` - MicroK8s addons, syncthing, samba config
- `group_vars/tailnet.yml` - Tailscale settings
- `host_vars/oldboy.yml` - Server-specific shares and K8s config
- `inventory/hosts` - Server inventory (secrets injected at runtime via CI)

## Container Services

- `containers/files/` - Nginx-based file server with CORS and compression

## Utility Scripts

- **`scripts/gen-schemas.ts`** - Converts Zod schemas to JSON Schema format
- **`scripts/update-secrets`** - Updates GitHub repository secrets from `ansible/github-secrets.json`

## Development Notes

- Single package at `packages/infra/` with its own `tsconfig.json` and `package.json`
- **Use aube for package management and script running** — node 24 provides the runtime
- Type checking must pass before commits (Lefthook)
- oxlint handles linting, oxfmt handles code formatting
- The system runs on minimal hardware (2014 MacBook Pro)
- No direct firewall port exposure on home network — Rathole client connects outbound
- Tailscale provides secure access to internal Kubernetes cluster for CI/CD
- Secrets managed through GitHub repository secrets and Pulumi configuration
