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

- `bun typecheck:infra` - Type check infrastructure package
- `bun typecheck:k8s` - Type check Kubernetes package
- `bun typecheck:routes` - Type check routes package
- `./scripts/gen-schemas.ts` - Generate TypeScript schemas from Zod definitions
- `bunx @biomejs/biome check --write` - Format and lint code

### Git Hooks

The project uses Lefthook for pre-commit validation:

- Runs Biome formatting and linting on staged files
- Runs type checking on all three packages before commit

### Package Management

- Uses Bun as the runtime and package manager
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

**Zod V4 Features:**
- 14x faster string parsing, 7x faster arrays/objects
- `z.interface()` for optional properties
- `z.stringbool()` for "true"/"false"/"1"/"0" to boolean coercion
- `z.templateLiteral()` for template literal types
- File schemas with `.maxSize()` and `.mimeType()`
- `.toJSONSchema()` conversion
- `z.prettifyError()` formatting
- `.overwrite()` method for schema merging

### Cross-Package Dependencies

Packages communicate via Pulumi StackReferences:

- K8s package references tunnel outputs from infra package
- Routes package references both tunnel and service outputs
- Reference schemas are defined in `references.schemas.ts` files

### Service Flow

External traffic follows this path:
`https://hostname` → Cloudflare → Tunnel → `http://service-name.jaritanet.svc.cluster.local`

## GitHub Actions

The repository uses GitHub Actions for continuous deployment and monitoring:

### Continuous Deployment (`cd.yml`)
Triggered on pushes to main branch affecting package files:
1. **Infrastructure** - Deploys Cloudflare tunnels using Pulumi
2. **Kubernetes** - Connects to Tailscale, deploys K8s services  
3. **Routes** - Configures DNS records and tunnel routing
4. **Email Tests** - Runs integration tests after deployment

### Email Integration Tests (`email-tests.yml`)
Hourly monitoring of email infrastructure:
- Tests MX records for Fastmail
- Validates SPF, DKIM (fm1-fm4), and DMARC records
- Creates/closes GitHub issues based on test results

### Schema Generation (`generate-schemas.yml`)
Daily schema updates:
- Generates JSON schemas from Zod definitions
- Commits with `[skip ci]` tag

### Ansible Deployment (`run-playbook.yml`)
Triggered on Ansible changes:
- Connects via Tailscale
- Runs server provisioning playbooks
- Updates GitHub secrets from kubeconfig

### Container Builds
- `build-files-container.yml` - File server container
- Version update workflows for services

## Ansible Infrastructure

Server provisioning and configuration:

### Playbook Structure (`playbook.yml`)
Three-stage deployment targeting different host groups:

1. **Common Configuration** (`hosts: all`)
   - Base system setup for all servers
   - User management and SSH hardening
   - Essential tool installation (helix, mise, fish, btop, broot)

2. **Homeserver Configuration** (`hosts: homeservers`)  
   - MicroK8s cluster setup with essential addons
   - NFS and Samba file sharing
   - Syncthing for file synchronization
   - Downloader services

3. **Tailnet Integration** (`hosts: tailnet`)
   - Tailscale VPN connectivity
   - Automatic network mesh joining

### Key Ansible Roles

**`common/`** - Base system hardening and setup:
- System package updates (dist-upgrade)
- Package installation via APT and Azlux repository
- SSH hardening configurations
- Python Kubernetes client setup

**`microk8s/`** - Kubernetes cluster management:
- MicroK8s installation via snap (stable channel)
- Essential addons: community, dns, storage, helm, rbac, hostpath-storage, metrics-server
- User group management for K8s access
- Service account creation for GitHub CI/CD
- Kubeconfig generation and secret extraction for CI
- Tailscale integration for secure cluster access

**`users/`** - User account and access management
**`tailscale/`** - VPN network connectivity and mesh setup
**`nfs/`** - Network file system for shared storage
**`samba/`** - SMB file sharing services
**`syncthing/`** - Peer-to-peer file synchronization

### Configuration Management
- `group_vars/all.yml` - Global variables (username, tailscale settings)
- `group_vars/homeservers.yml` - Homeserver-specific configuration
- `group_vars/tailnet.yml` - Tailscale network settings
- `inventory/hosts` - Server inventory and group definitions

### GitHub Integration
MicroK8s role generates:
- Service accounts for GitHub Actions
- Cluster admin tokens
- Tailscale hostnames for cluster access
- Secrets in `github-secrets.json` for CI/CD

## Container Services

Custom service definitions:
- File server container using Caddy with CORS and compression
- Dockerfile and nginx.conf for deployments

## Utility Scripts

**`scripts/gen-schemas.ts`** - Converts Zod schemas to JSON Schema format, creates files in `schemas/` directory

**`scripts/update-secrets`** - Updates GitHub repository secrets from `ansible/github-secrets.json`

## Development Notes

- Each package has its own `tsconfig.json` and `package.json`
- **Use Bun instead of npm** for all tasks - commands should use `bun` prefix
- Type checking must pass for all packages before commits via Lefthook
- Biome handles code formatting and linting with specific style rules
- Pre-commit hooks automatically format code and run type checks
- The system is designed to run on minimal hardware (currently a 2014 MacBook Pro)
- All external services are secured through Cloudflare's edge network
- No direct firewall port exposure required due to tunnel architecture
- Tailscale provides secure access to internal Kubernetes cluster
- Secrets are managed through GitHub repository secrets and Pulumi configuration
