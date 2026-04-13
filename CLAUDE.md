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

## Common Commands

### Development

- `bun run typecheck:infra` - Type check infrastructure package
- `bun run test` - Run tests (uses vitest on Node - do NOT use `bun test` directly, Pulumi needs Node's v8)
- `./scripts/gen-schemas.ts` - Generate JSON schemas from Zod definitions
- `bun run lint` - Lint code with oxlint
- `bun run lint:fix` - Lint and auto-fix with oxlint
- `bun run fmt` - Format code with oxfmt
- `bun run fmt:check` - Check formatting with oxfmt

### Git Hooks

The project uses Lefthook for pre-commit validation:

- Runs oxlint with auto-fix on staged files
- Runs oxfmt formatting on staged files
- Runs type checking before commit

### Package Management

- Uses Bun as the package manager and script runner
- Workspace-based monorepo with shared dependencies
- Run commands from root directory

## Architecture

### Single Pulumi Stack

Everything deploys in one `pulumi up` from `packages/infra/`:

- **`src/modules/gateway.ts`** — Hetzner VPS + firewall + Rathole server provisioning
- **`src/modules/ingress.ts`** — Traefik Helm chart, Rathole client, IngressRoute CRDs
- **`src/modules/dns.ts`** — Cloudflare A records, Fastmail MX/DKIM, Bluesky ATProto
- **`src/templates/service.ts`** — K8s Deployment/Service/PV/PVC templates
- **`src/main.ts`** — Orchestrates all modules
- **`src/conf.ts`** / **`src/conf.schemas.ts`** — Unified Zod config schema

### Configuration System

All config uses Zod V4 schemas for runtime validation. Configuration lives in `Pulumi.main.yaml`. Schema definitions in `*.schemas.ts` files, regenerated via gen-schemas script.

### Service Flow

External traffic follows this path:
`https://hostname` -> Hetzner VPS (Rathole) -> K8s cluster (Rathole client) -> Traefik (TLS + routing) -> `http://service-name.jaritanet.svc.cluster.local`

### Key Components

- **Rathole** — Rust-based TCP tunnel. Server on VPS, client in K8s. Stateless relay, no TLS/routing knowledge.
- **Traefik** — Ingress controller with built-in ACME. Handles Let's Encrypt certs via DNS-01 challenge against Cloudflare.
- **Cloudflare** — DNS only. A records pointing at VPS IP, plus Fastmail MX/DKIM and Bluesky ATProto records.

## GitHub Actions

### CI/CD (`ci-cd.yml`)

Triggered on pushes to main branch affecting package files, or manually via workflow_dispatch:

1. **Test** - Type checks, lints, runs vitest suite
2. **Deploy** (main branch only) - Single `pulumi up` deploying everything

### Schema Generation (`generate-schemas.yml`)

Generates JSON schemas from Zod definitions on changes or daily schedule. Commits with `[skip ci]` tag.

### App Version Updates (`update-apps.yml`)

Daily check for new releases of deployed services (currently Navidrome). Uses a GitHub App token so version bump commits trigger the CI/CD pipeline.

### Ansible Deployment (`run-playbook.yml`)

Triggered on ansible/ changes. Connects via Tailscale, runs playbooks, updates GitHub secrets.

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
- **Use Bun for package management and script running**, but tests/Pulumi run on Node under the hood
- Type checking must pass before commits (Lefthook)
- oxlint handles linting, oxfmt handles code formatting
- The system runs on minimal hardware (2014 MacBook Pro)
- No direct firewall port exposure on home network — Rathole client connects outbound
- Tailscale provides secure access to internal Kubernetes cluster for CI/CD
- Secrets managed through GitHub repository secrets and Pulumi configuration
