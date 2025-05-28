# Monitoring Stack

This document describes the monitoring setup for JaritaNet services using Prometheus and Grafana.

## Overview

The monitoring stack consists of:
- **Prometheus**: Metrics collection and storage
- **Grafana**: Visualization and dashboards
- **Pre-configured dashboards**: Kubernetes overview and JaritaNet services

## Deployment

The monitoring stack is deployed automatically when the `monitoring` configuration is present in `Pulumi.main.yaml`.

### Configuration

```yaml
jaritanet-k8s:monitoring:
  prometheus:
    name: prometheus
    hostname: prometheus.radiosilence.dev
    proxied: false
    args:
      retention: "30d"
      storageSize: "20Gi"
      persistence:
        hostPath: /srv/prometheus
        nodeAffinityHostname: oldboy
  grafana:
    name: grafana
    hostname: grafana.radiosilence.dev
    proxied: false
    args:
      adminUser: admin
      adminPassword: admin123
      storageSize: "5Gi"
      persistence:
        hostPath: /srv/grafana
        nodeAffinityHostname: oldboy
```

## Accessing Dashboards

### Via Port Forward

#### Prometheus
```bash
kubectl port-forward -n jaritanet service/prometheus-service 9090:9090
```
Then visit: http://localhost:9090

#### Grafana
```bash
kubectl port-forward -n jaritanet service/grafana-service 3000:3000
```
Then visit: http://localhost:3000
- Username: `admin`
- Password: `admin123` (or as configured)

### Quick Access Script

Create a script to easily access both services:

```bash
#!/bin/bash
# monitoring-access.sh

echo "Starting port forwards for monitoring services..."

# Start Prometheus port forward in background
kubectl port-forward -n jaritanet service/prometheus-service 9090:9090 &
PROM_PID=$!

# Start Grafana port forward in background
kubectl port-forward -n jaritanet service/grafana-service 3000:3000 &
GRAFANA_PID=$!

echo "Prometheus available at: http://localhost:9090"
echo "Grafana available at: http://localhost:3000"
echo "Press Ctrl+C to stop port forwards"

# Wait for interrupt signal
trap "kill $PROM_PID $GRAFANA_PID; exit" INT
wait
```

Make it executable:
```bash
chmod +x monitoring-access.sh
./monitoring-access.sh
```

## Pre-configured Dashboards

### Kubernetes Overview
- Node CPU and Memory usage
- Pod status and health
- Cluster resource utilization

### JaritaNet Services
- Service health status
- HTTP request rates
- Response times
- Cloudflared tunnel status

## Adding Metrics to Services

To enable Prometheus scraping for your services, add annotations to your service:

```yaml
metadata:
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "8080"      # Port where metrics are exposed
    prometheus.io/path: "/metrics"  # Metrics endpoint path (optional, defaults to /metrics)
```

### Example Service with Metrics

If your application exposes metrics on port 8080 at `/metrics`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "8080"
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
```

## Metric Collection

### Automatic Discovery

Prometheus automatically discovers and scrapes:
- Kubernetes API server metrics
- Node metrics (via cAdvisor)
- Services with proper annotations
- Cloudflared tunnel metrics

### Custom Metrics

To add custom scrape configurations, edit the Prometheus ConfigMap:

```bash
kubectl edit configmap prometheus-config -n jaritanet
```

Add new scrape jobs under `scrape_configs`:

```yaml
- job_name: 'my-custom-service'
  static_configs:
    - targets: ['my-service:8080']
  metrics_path: /custom/metrics
```

## Storage and Retention

### Prometheus
- **Retention**: 30 days (configurable)
- **Storage**: 20Gi persistent volume
- **Location**: `/srv/prometheus` on the node

### Grafana
- **Storage**: 5Gi persistent volume
- **Location**: `/srv/grafana` on the node
- **Backup**: Configuration and dashboards are stored in the persistent volume

## Troubleshooting

### Check Pod Status
```bash
kubectl get pods -n jaritanet | grep -E "(prometheus|grafana)"
```

### View Logs
```bash
# Prometheus logs
kubectl logs -n jaritanet deployment/prometheus-deployment

# Grafana logs
kubectl logs -n jaritanet deployment/grafana-deployment
```

### Verify Configuration
```bash
# Check Prometheus config
kubectl get configmap prometheus-config -n jaritanet -o yaml

# Check Grafana datasources
kubectl get configmap grafana-datasources -n jaritanet -o yaml
```

### Test Connectivity
```bash
# Test Prometheus from within cluster
kubectl run test-pod --rm -i --tty --image=curlimages/curl -- curl http://prometheus-service.jaritanet.svc.cluster.local:9090/api/v1/targets

# Test Grafana from within cluster
kubectl run test-pod --rm -i --tty --image=curlimages/curl -- curl http://grafana-service.jaritanet.svc.cluster.local:3000/api/health
```

### Common Issues

#### Prometheus Not Scraping Targets
1. Check service annotations
2. Verify network policies allow traffic
3. Ensure metrics endpoint is accessible
4. Check Prometheus logs for errors

#### Grafana Can't Connect to Prometheus
1. Verify Prometheus service is running
2. Check datasource configuration
3. Test network connectivity between services

#### Missing Metrics
1. Verify application exposes metrics
2. Check Prometheus targets page (`/targets`)
3. Ensure scrape job configuration is correct

## Security

### Access Control
- Grafana requires authentication (admin/admin123)
- Prometheus has no authentication by default
- Services are not exposed externally (use port-forward for access)

### Network Policies
Consider implementing network policies to restrict access:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: monitoring-policy
spec:
  podSelector:
    matchLabels:
      app: prometheus
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: grafana
```

## Backup and Recovery

### Backup Prometheus Data
```bash
# Create backup of Prometheus data
kubectl exec -n jaritanet deployment/prometheus-deployment -- tar czf /tmp/prometheus-backup.tar.gz -C /prometheus .
kubectl cp jaritanet/prometheus-deployment-xxx:/tmp/prometheus-backup.tar.gz ./prometheus-backup.tar.gz
```

### Backup Grafana
```bash
# Backup Grafana data
kubectl exec -n jaritanet deployment/grafana-deployment -- tar czf /tmp/grafana-backup.tar.gz -C /var/lib/grafana .
kubectl cp jaritanet/grafana-deployment-xxx:/tmp/grafana-backup.tar.gz ./grafana-backup.tar.gz
```

## Scaling

### Prometheus High Availability
For production, consider:
- Multiple Prometheus replicas with Thanos
- Remote storage solutions
- Federation for large clusters

### Grafana High Availability
- Use external database (PostgreSQL/MySQL)
- Shared storage for dashboards
- Load balancer for multiple instances