# JARITANET

[![🧪 Tests](https://github.com/radiosilence/jaritanet/actions/workflows/test.yml/badge.svg)](https://github.com/radiosilence/jaritanet/actions/workflows/test.yml)
[![🚀 Deploy](https://github.com/radiosilence/jaritanet/actions/workflows/cd.yml/badge.svg)](https://github.com/radiosilence/jaritanet/actions/workflows/cd.yml)
[![📧 Email Tests](https://github.com/radiosilence/jaritanet/actions/workflows/email-tests.yml/badge.svg)](https://github.com/radiosilence/jaritanet/actions/workflows/email-tests.yml)

Infrastructure-as-code monorepo for securely exposing Kubernetes services through Cloudflare Tunnels.

## Architecture

Three Pulumi packages deploy in sequence to create a complete service exposure system:

```mermaid
graph TB
    subgraph "External Access"
        User[User] --> CF[Cloudflare Edge]
    end

    subgraph "Cloudflare"
        CF --> Tunnel[Zero Trust Tunnel]
    end

    subgraph "Infrastructure (packages/infra)"
        Tunnel --> TunnelConfig[Tunnel Creation]
    end

    subgraph "DNS & Routing (packages/routes)"
        CF --> DNS[DNS Records]
        Tunnel --> Ingress[Service Ingress Rules]
        DNS --> Ingress
    end

    subgraph "Server Infrastructure"
        subgraph "oldboy - 2014 MacBook Pro"
            TunnelConfig --> Cloudflared[Cloudflared Daemon]

            subgraph "MicroK8s Cluster"
                Cloudflared --> Services[K8s Services]

                subgraph "Deployed Services (packages/k8s)"
                    Services --> FileServer[File Server]
                    Services --> Navidrome[Navidrome - Music Streaming]
                    Services --> Blit[Blit - Web App]
                end
            end

            subgraph "Host Services"
                Tailscale[Tailscale VPN]
                Storage[NFS/Samba Storage]
                Sync[Syncthing]
            end
        end
    end
```

## Package Structure

**packages/infra** - Pulumi TypeScript package for Cloudflare Zero Trust tunnels

- Establishes secure tunnel endpoints using Cloudflare API
- Configures Cloudflare access policies and authentication

**packages/k8s** - Pulumi TypeScript package for Kubernetes service deployment

- Connects to MicroK8s clusters via Tailscale VPN
- Deploys cloudflared daemon pods for tunnel connectivity
- Manages Kubernetes service deployments with Helm charts

**packages/routes** - Pulumi TypeScript package for DNS and tunnel routing

- Maps external domains to internal services via Cloudflare DNS
- Manages Bluesky protocol and Fastmail DNS records
- Creates Cloudflare tunnel ingress rules for service routing

## Deployment Flow

1. **Infrastructure** deploys Cloudflare tunnels
2. **Kubernetes** connects clusters and deploys services
3. **Routes** configures DNS and ingress routing

Traffic flows: `External Domain` → `Cloudflare` → `Tunnel` → `K8s Service`

## Server Management

Ansible playbooks provision and configure servers:

- MicroK8s cluster setup with storage and networking
- Tailscale VPN for secure cluster access
- File sharing via NFS and Samba
- Automated service account creation for CI/CD

## Development

```bash
bun typecheck:infra  # Type check infrastructure
bun typecheck:k8s    # Type check Kubernetes
bun typecheck:routes # Type check routes
./scripts/gen-schemas.ts  # Generate schemas
```
