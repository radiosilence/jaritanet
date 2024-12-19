# README.md

# App Stack Helm Charts

This repository contains Helm charts for deploying various stateful applications.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.0+
- PV provisioner support in the underlying infrastructure
- LoadBalancer support (for ingress)

## Installation

### First Time Setup

1. Clone this repository:

```bash
git clone https://github.com/yourusername/app-stack
cd app-stack
```

2. Update dependencies:

```bash
helm dependency update
```

### Deploying Navidrome

1. Create namespace:

```bash
kubectl create namespace navidrome
```

2. Deploy using included values:

```bash
helm install navidrome . \
  --namespace navidrome \
  --set navidrome.enabled=true \
  -f values/navidrome.yaml
```

### Deploying Files Service

1. Create namespace:

```bash
kubectl create namespace files
```

2. Deploy using included values:

```bash
helm install files . \
  --namespace files \
  --set files.enabled=true \
  -f values/files.yaml
```

### Upgrading Deployments

To upgrade an existing deployment:

```bash
helm upgrade navidrome . \
  --namespace navidrome \
  --set navidrome.enabled=true \
  -f values/navidrome.yaml
```

### Uninstalling

To remove a deployment:

```bash
helm uninstall navidrome -n navidrome
# or
helm uninstall files -n files
```

## Configuration

See the values.yaml files in each chart's directory for the full list of configurable parameters.

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request
