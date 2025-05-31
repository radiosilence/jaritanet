# JARITANET

[![📧 Email Tests](https://github.com/radiosilence/jaritanet/actions/workflows/integration-tests.yml/badge.svg)](https://github.com/radiosilence/jaritanet/actions/workflows/integration-tests.yml)
[![🌐 Service Tests](https://github.com/radiosilence/jaritanet/actions/workflows/service-tests.yml/badge.svg)](https://github.com/radiosilence/jaritanet/actions/workflows/service-tests.yml)
[![📧 Mail Server Status](https://img.shields.io/badge/📧_Mail_Servers-Monitored-green)](https://github.com/radiosilence/jaritanet/actions/workflows/integration-tests.yml)
[![🦋 Bluesky DNS](https://img.shields.io/badge/🦋_Bluesky-Configured-blue)](https://github.com/radiosilence/jaritanet/actions/workflows/service-tests.yml)
[![🔥 Tunnel Status](https://img.shields.io/badge/🔥_Cloudflare_Tunnels-Active-orange)](https://github.com/radiosilence/jaritanet/actions/workflows/service-tests.yml)

JARITANET is a comprehensive infrastructure-as-code system that provides secure, tunneled access to services running on Kubernetes clusters through Cloudflare Tunnels.

> **Note**: This entire infrastructure runs on a 2014 MacBook Pro sitting in a cupboard, demonstrating that you don't need enterprise hardware to run a sophisticated cloud-native setup.

## System Architecture

The system is built as a monorepo with three main Pulumi packages that deploy in sequence:

1. **Infrastructure Package** - Creates Cloudflare tunnels
2. **Kubernetes Package** - Deploys services and tunnel connectors to K8s
3. **Routes Package** - Configures DNS records and tunnel routing

Additional components include Ansible playbooks for server provisioning, container definitions for custom services, and utility scripts.

## Package Overview

### Infrastructure Package (`packages/infra`)

**Purpose**: Creates and manages Cloudflare Zero Trust tunnels that provide secure connectivity to internal services.

**Key Components**:
- `main.ts` - Entry point that creates tunnel resources
- `modules/tunnel.ts` - Tunnel creation logic using Cloudflare provider
- `conf.ts` - Configuration management with Zod validation
- `conf.schemas.ts` - Type-safe configuration schemas

**What it does**:
- Generates cryptographically secure tunnel secrets (256 bytes)
- Creates Cloudflare Zero Trust tunnels with specified names
- Outputs tunnel configuration for use by other packages
- Manages tunnel lifecycle through Pulumi state

**Dependencies**: 
- `@pulumi/cloudflare` - Cloudflare resource management
- `@pulumi/random` - Secure secret generation
- `zod` - Runtime type validation

### Kubernetes Package (`packages/k8s`)

**Purpose**: Deploys services to Kubernetes clusters and runs cloudflared daemon to connect services to Cloudflare tunnels.

**Key Components**:
- `main.ts` - Main deployment orchestration
- `templates/service.ts` - Generic Kubernetes service templates
- `templates/cloudflared.ts` - Cloudflared daemon deployment
- `kubeconfig.ts` - Kubernetes cluster authentication
- `references.ts` - Cross-stack resource references

**What it does**:
- Creates a dedicated `jaritanet` namespace in Kubernetes
- Deploys user-defined services from configuration
- Runs cloudflared as a deployment to establish tunnel connections
- Retrieves tunnel tokens from Cloudflare for authentication
- Provides service discovery within the cluster
- Manages service health checking and monitoring

**Configuration**:
- Services are defined with name, hostname, proxy settings, and deployment args
- Cloudflared configuration includes resource limits and replica settings
- Supports custom container images, environment variables, and volume mounts

**Dependencies**:
- `@pulumi/kubernetes` - Kubernetes resource management
- References tunnel resources from infrastructure package

### Routes Package (`packages/routes`)

**Purpose**: Configures DNS records and tunnel routing to make services accessible via custom domains.

**Key Components**:
- `main.ts` - Main routing configuration
- `tunnels/service.ts` - Service ingress and DNS record management
- `tunnels/tunnel-config.ts` - Tunnel configuration for Cloudflare
- `modules/bluesky.ts` - Bluesky protocol DNS configuration
- `modules/fastmail.ts` - Fastmail service DNS configuration

**What it does**:
- Creates DNS records for each service hostname
- Configures tunnel ingress rules to route traffic to services
- Manages domain verification and SSL certificate provisioning
- Integrates with external service modules (Bluesky, Fastmail)
- Maps service URLs to internal Kubernetes service endpoints

**Service Resolution**:
Services are accessed via: `https://hostname` → Cloudflare → Tunnel → `http://service-name.jaritanet.svc.cluster.local`

**Dependencies**:
- References tunnel from infrastructure package
- References services from Kubernetes package
- Manages Cloudflare DNS zones and records

## Configuration System

All packages use Zod schemas for type-safe configuration validation. Configuration is provided through Pulumi config files (YAML) and validated at runtime.

### Infrastructure Configuration
```
cloudflare:
  accountId: string
tunnel:
  name: string
```

### Kubernetes Configuration
```
cloudflare:
  accountId: string
cloudflared:
  name: string
  args: CloudflaredArgs
services:
  - name: string
    hostname: string
    proxied: boolean
    args: ServiceArgs
```

### Routes Configuration
```
serviceStacks: StackReference[]
zones: Zone[]
cloudflare: CloudflareConfig
bluesky: BlueskyConfig
fastmail: FastmailConfig
```

## Deployment Flow

1. **Infrastructure Deployment**: Creates Cloudflare tunnels and generates secrets
2. **Kubernetes Deployment**: Deploys services and establishes tunnel connections
3. **Routes Deployment**: Configures DNS routing and makes services publicly accessible

Each package references outputs from previous deployments using Pulumi StackReferences, ensuring proper dependency ordering.

## Integration Testing

The system includes comprehensive automated integration tests that run every 6 hours to ensure critical infrastructure remains healthy. The tests cover:

### 📧 Mail Server Configuration
- **MX Records**: Verifies Fastmail MX records (in1/in2.fastmail.com) are properly configured
- **SPF Records**: Checks SPF includes for Fastmail authorization
- **DKIM Records**: Tests all DKIM selectors (fm1-fm4) for domain authentication
- **DMARC Records**: Validates DMARC policy configuration

### 🦋 Bluesky DNS Configuration
- **DID Records**: Verifies Bluesky decentralized identifier records for domain verification

### 🌐 Service Availability
- **HTTP Health Checks**: Tests that all services (blit.cc, bambi.art, files.blit.cc) are responding
- **Response Time Monitoring**: Tracks service performance metrics

### 🔥 Cloudflare Tunnel Status
- **Tunnel Connectivity**: Verifies services are accessible through Cloudflare's edge network
- **CF Header Detection**: Confirms traffic is properly routed through Cloudflare

### 🚨 Automated Issue Management
When mail server configuration issues are detected, the system automatically:
- Creates a GitHub issue with diagnostic information
- Provides specific debugging commands and steps
- Auto-closes issues when problems are resolved
- Prevents duplicate issue creation

The integration tests provide early warning for infrastructure problems and ensure email delivery remains reliable, which is critical for business operations.

## Additional Components

### Ansible Infrastructure (`ansible/`)

Automated server provisioning and configuration management:

**Playbooks**:
- Common system configuration (users, tools, security)
- Homeserver setup (MicroK8s, NFS, Samba, Syncthing)
- Tailscale network integration

**Roles**:
- `common` - Base system configuration
- `users` - User account management
- `microk8s` - Kubernetes cluster setup
- `nfs` - Network file sharing
- `tailscale` - VPN network connectivity

### Container Services (`containers/`)

**File Server Container**:
- Caddy-based HTTP file server with web interface
- CORS-enabled for cross-origin requests
- Automatic gzip/zstd compression
- Security headers and access logging
- Designed for internal network file sharing

### Utility Scripts (`scripts/`)

**Secret Management** (`update-secrets`):
- Reads secrets from `ansible/github-secrets.json`
- Updates GitHub repository secrets via CLI
- Supports multiple repository deployment access
- Used for CI/CD authentication

## Development Tools

**Code Quality**:
- Biome for code formatting and linting
- TypeScript for type safety across all packages
- Lefthook for git hooks and pre-commit checks

**Package Management**:
- Bun as the JavaScript runtime and package manager
- Workspace-based monorepo structure
- Shared dependencies and TypeScript configuration

**Build System**:
- Individual TypeScript compilation per package
- Pulumi for infrastructure deployment
- GitHub Actions integration via secret management

## Security Model

**Network Security**:
- All external traffic routes through Cloudflare's edge network
- Cloudflare Tunnels eliminate need for open firewall ports
- Services remain private and accessible only via authenticated tunnels

**Authentication**:
- Kubernetes cluster access via service account tokens
- Cloudflare API authentication via account IDs and tokens
- Tunnel authentication via cryptographically secure secrets

**Configuration Security**:
- Sensitive values managed through Pulumi configuration encryption
- GitHub secrets for CI/CD authentication
- No hardcoded credentials in source code

This system provides a complete infrastructure solution for securely exposing internal services through Cloudflare's global network while maintaining infrastructure as code practices and type safety throughout the deployment pipeline.