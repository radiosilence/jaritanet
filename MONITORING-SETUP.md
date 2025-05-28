# JaritaNet Monitoring Setup

This branch adds comprehensive monitoring capabilities to the JaritaNet Kubernetes infrastructure using Prometheus for metrics collection and Grafana for visualization.

## Quick Start

1. **Deploy the monitoring stack:**
   ```bash
   cd packages/k8s
   pulumi up
   ```

2. **Access the dashboards:**
   ```bash
   ./scripts/monitoring-access.sh
   ```

3. **Open your browser:**
   - Prometheus: http://localhost:9090
   - Grafana: http://localhost:3000 (admin/admin123)

## What's Included

### Monitoring Infrastructure
- **Prometheus Server**: Metrics collection, storage, and alerting
- **Grafana**: Rich visualization and dashboard platform
- **Pre-configured Dashboards**: Kubernetes and JaritaNet service monitoring
- **Automatic Service Discovery**: Metrics from annotated services
- **Persistent Storage**: 30-day retention for metrics, persistent dashboards

### Monitored Components
- Kubernetes cluster metrics (nodes, pods, containers)
- JaritaNet application services (navidrome, files, blit)
- Cloudflared tunnel metrics
- Custom application metrics (when properly annotated)

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Applications  │    │   Kubernetes    │    │   Cloudflared   │
│   /metrics      │◄───┤   API Server    │◄───┤   Metrics       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                 ┌───────────────▼────────────────┐
                 │         Prometheus             │
                 │    (Storage & Collection)      │
                 └───────────────┬────────────────┘
                                 │
                 ┌───────────────▼────────────────┐
                 │           Grafana              │
                 │    (Visualization & UI)        │
                 └────────────────────────────────┘
```

## Files Added/Modified

### New Monitoring Templates
- `packages/k8s/src/templates/prometheus.schemas.ts` - Prometheus configuration schema
- `packages/k8s/src/templates/prometheus.ts` - Prometheus deployment template
- `packages/k8s/src/templates/grafana.schemas.ts` - Grafana configuration schema
- `packages/k8s/src/templates/grafana.ts` - Grafana deployment template

### Modified Files
- `packages/k8s/src/conf.schemas.ts` - Added monitoring configuration schemas
- `packages/k8s/src/main.ts` - Integrated monitoring stack deployment
- `packages/k8s/src/templates/service.ts` - Added Prometheus annotations by default
- `packages/k8s/src/templates/cloudflared.ts` - Added metrics service for cloudflared
- `packages/k8s/Pulumi.main.yaml` - Added monitoring configuration

### Documentation & Scripts
- `packages/k8s/MONITORING.md` - Detailed monitoring documentation
- `scripts/monitoring-access.sh` - Quick access script for dashboards
- `MONITORING-SETUP.md` - This overview document

## Configuration

The monitoring stack is configured in `packages/k8s/Pulumi.main.yaml`:

```yaml
jaritanet-k8s:monitoring:
  prometheus:
    name: prometheus
    args:
      retention: "30d"          # How long to keep metrics
      storageSize: "20Gi"       # Storage allocation
      persistence:
        hostPath: /srv/prometheus
        nodeAffinityHostname: oldboy
  grafana:
    name: grafana
    args:
      adminPassword: admin123   # Change this!
      storageSize: "5Gi"
      persistence:
        hostPath: /srv/grafana
        nodeAffinityHostname: oldboy
```

## Default Dashboards

### Kubernetes Overview
- Node CPU and memory utilization
- Pod status and distribution
- Cluster resource consumption
- Container metrics via cAdvisor

### JaritaNet Services
- Service health and availability
- HTTP request rates and response times
- Error rates and status codes
- Cloudflared tunnel connection status

## Adding Metrics to Your Services

Services automatically get Prometheus scraping enabled with these annotations:
```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8080"
  prometheus.io/path: "/metrics"
```

For custom metrics paths or ports, modify the annotations accordingly.

## Access Methods

### 1. Port Forward (Recommended for Development)
```bash
# Automated script
./scripts/monitoring-access.sh

# Manual port forwards
kubectl port-forward -n jaritanet service/prometheus-service 9090:9090
kubectl port-forward -n jaritanet service/grafana-service 3000:3000
```

### 2. Cluster Internal Access
- Prometheus: `http://prometheus-service.jaritanet.svc.cluster.local:9090`
- Grafana: `http://grafana-service.jaritanet.svc.cluster.local:3000`

### 3. External Access (Future)
Configure ingress or load balancer for external access in production.

## Storage Requirements

### Host Paths
Ensure these directories exist on the target node (`oldboy`):
```bash
sudo mkdir -p /srv/prometheus /srv/grafana
sudo chown -R 472:472 /srv/grafana    # Grafana user
sudo chown -R 65534:65534 /srv/prometheus  # Nobody user
```

### Persistent Volumes
- Prometheus: 20Gi for metrics storage
- Grafana: 5Gi for dashboards and configuration

## Security Considerations

- Grafana requires authentication (admin/admin123)
- Prometheus has no authentication by default
- Services are not exposed externally
- Consider implementing network policies for production

## Troubleshooting

### Common Issues

1. **Pods not starting:**
   ```bash
   kubectl get pods -n jaritanet
   kubectl describe pod <pod-name> -n jaritanet
   ```

2. **Missing metrics:**
   - Check service annotations
   - Verify `/metrics` endpoint exists
   - Review Prometheus targets page

3. **Grafana can't connect to Prometheus:**
   - Verify both services are running
   - Check datasource configuration
   - Test network connectivity

### Useful Commands
```bash
# Check monitoring stack status
kubectl get all -n jaritanet | grep -E "(prometheus|grafana)"

# View configuration
kubectl get configmap -n jaritanet | grep -E "(prometheus|grafana)"

# Check logs
kubectl logs -n jaritanet deployment/prometheus-deployment
kubectl logs -n jaritanet deployment/grafana-deployment
```

## Development Workflow

1. **Test changes locally:**
   ```bash
   cd packages/k8s
   pulumi preview
   ```

2. **Deploy updates:**
   ```bash
   pulumi up
   ```

3. **Access dashboards:**
   ```bash
   ./scripts/monitoring-access.sh
   ```

4. **Validate metrics:**
   - Check Prometheus targets: http://localhost:9090/targets
   - View dashboards: http://localhost:3000

## Production Considerations

- Change default Grafana password
- Implement proper backup strategy
- Consider Prometheus federation for scaling
- Add alerting rules and notification channels
- Implement network policies for security
- Use external storage for high availability

## Next Steps

- [ ] Add custom alerting rules
- [ ] Implement dashboard backups
- [ ] Add more comprehensive service metrics
- [ ] Set up notification channels (Slack, email)
- [ ] Configure external access with proper authentication
- [ ] Add log aggregation (ELK/Loki)