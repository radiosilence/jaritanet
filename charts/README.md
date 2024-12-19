# App Stack Helm Charts

This repository contains Helm charts for deploying various stateful applications with a shared common template library.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.0+
- PV provisioner support in the underlying infrastructure
- LoadBalancer support (for ingress)

## Repository Structure

```
app-stack/
├── charts/
│   ├── common-stack/     # Shared template library
│   ├── files/           # Files service chart
│   └── navidrome/       # Navidrome chart
└── values/              # Default values for each application
```

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

### Automated Deployment (Recommended)

Using the provided Ansible playbook:

1. Install required Ansible collection:

```bash
ansible-galaxy collection install kubernetes.core
```

2. Deploy all enabled applications:

```bash
ansible-playbook deploy.yml
```

### Manual Deployment

#### Using the helper function

Add this to your `.bashrc` or `.zshrc`:

```bash
helm-deploy() {
    local chart_name=$1
    local chart_path="./charts/${chart_name}"
    local values_path=$(yq e '.annotations.["default-values"]' "${chart_path}/Chart.yaml")

    helm install ${chart_name} . \
        --namespace ${chart_name} \
        --set "${chart_name}.enabled=true" \
        -f "${values_path}"
}
```

Then deploy individual applications:

```bash
helm-deploy navidrome
# or
helm-deploy files
```

#### Standard Helm commands

Deploy Navidrome:

```bash
helm install navidrome . \
  --namespace navidrome \
  --set navidrome.enabled=true \
  -f values/navidrome.yaml
```

Deploy Files Service:

```bash
helm install files . \
  --namespace files \
  --set files.enabled=true \
  -f values/files.yaml
```

### Upgrading Deployments

To upgrade an existing deployment using the helper:

```bash
helm-upgrade() {
    local chart_name=$1
    local chart_path="./charts/${chart_name}"
    local values_path=$(yq e '.annotations.["default-values"]' "${chart_path}/Chart.yaml")

    helm upgrade ${chart_name} . \
        --namespace ${chart_name} \
        --set "${chart_name}.enabled=true" \
        -f "${values_path}"
}
```

Using standard Helm:

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

Each application has its own values file in the `values/` directory:

- `values/navidrome.yaml` - Configuration for Navidrome
- `values/files.yaml` - Configuration for Files service

Common configuration options are available in `charts/common-stack/values.yaml`.

## Adding New Applications

1. Create a new directory in `charts/` for your application
2. Copy the Chart.yaml template from an existing application
3. Create a values file in `values/`
4. Update the application's Chart.yaml to point to the values file
5. Add the application to the root Chart.yaml dependencies

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details
