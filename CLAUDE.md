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

JARITANET is an infrastructure-as-code monorepo that uses Pulumi to deploy a complete system for securely exposing Kubernetes services through Cloudflare Tunnels. The system consists of three main packages that deploy in sequence: infrastructure (Cloudflare tunnels), Kubernetes (services), and routes (DNS configuration).

## Common Commands

### Development

- `bun run typecheck:infra` - Type check infrastructure package
- `bun run typecheck:k8s` - Type check Kubernetes package
- `bun run typecheck:routes` - Type check routes package
- `bun run test` - Run tests (uses vitest on Node - do NOT use `bun test` directly, Pulumi needs Node's v8)
- `./scripts/gen-schemas.ts` - Generate JSON schemas from Zod definitions
- `bunx @biomejs/biome check --write` - Format and lint code

### Git Hooks

The project uses Lefthook for pre-commit validation:

- Runs Biome formatting and linting on staged files
- Runs type checking on all three packages before commit

### Package Management

- Uses Bun as the package manager and script runner
- Workspace-based monorepo with shared dependencies
- Run commands from root directory

## Architecture

### Package Structure

The codebase is organized as three Pulumi packages with strict deployment ordering:

1. **packages/infra/** - Creates Cloudflare Zero Trust tunnels
   - `src/main.ts` - Entry point
   - `src/modules/tunnel.ts` - Tunnel creation logic
   - `src/conf.ts` - Configuration with Zod validation

2. **packages/k8s/** - Deploys services to Kubernetes clusters
   - `src/main.ts` - Main deployment orchestration
   - `src/templates/service.ts` - Generic K8s service templates
   - `src/templates/cloudflared.ts` - Cloudflared daemon deployment
   - `src/kubeconfig.ts` - Cluster authentication
   - `src/references.ts` - Cross-stack resource references

3. **packages/routes/** - Configures DNS records and tunnel routing
   - `src/main.ts` - Main routing configuration
   - `src/tunnels/service.ts` - Service ingress and DNS management
   - `src/modules/bluesky.ts` - Bluesky protocol DNS
   - `src/modules/fastmail.ts` - Fastmail service DNS

### Configuration System

All packages use Zod V4 schemas for runtime type validation. Configuration files are located in each package's Pulumi.*.yaml files. Schema definitions are in `*.schemas.ts` files and can be regenerated using the gen-schemas script.

### Cross-Package Dependencies

Packages communicate via Pulumi StackReferences:

- K8s package references tunnel outputs from infra package
- Routes package references both tunnel and service outputs
- Reference schemas are defined in `references.schemas.ts` files

### Service Flow

External traffic follows this path:
`https://hostname` -> Cloudflare -> Tunnel -> `http://service-name.jaritanet.svc.cluster.local`

## GitHub Actions

### CI/CD (`ci-cd.yml`)

Triggered on pushes to main branch affecting package files, or manually via workflow_dispatch:

1. **Test** - Type checks all packages, runs vitest suite
2. **Deploy** (main branch only) - Deploys infra, k8s, and routes packages in sequence via Pulumi

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

- Each package has its own `tsconfig.json` and `package.json`
- **Use Bun for package management and script running**, but tests/Pulumi run on Node under the hood
- Type checking must pass for all packages before commits (Lefthook)
- Biome handles code formatting and linting
- The system runs on minimal hardware (2014 MacBook Pro)
- All external services secured through Cloudflare's edge network
- No direct firewall port exposure - tunnel architecture only
- Tailscale provides secure access to internal Kubernetes cluster
- Secrets managed through GitHub repository secrets and Pulumi configuration
