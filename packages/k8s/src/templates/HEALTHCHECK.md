# Kubernetes Health Checks

This module provides comprehensive health check functionality for Kubernetes deployments with standardized configuration and response formats.

## Overview

Health checks are essential for Kubernetes to determine when your application is ready to receive traffic (readiness), still running properly (liveness), and has finished starting up (startup). This implementation follows industry standards and provides flexible configuration options.

## Configuration

### Basic Health Check Configuration

```typescript
const serviceConfig = {
  name: "my-service",
  hostname: "api.example.com",
  args: {
    // ... other service args
    healthCheck: {
      path: "/_health",              // Health check endpoint path
      port: 3000,                   // Port to check (defaults to httpPort)
      initialDelaySeconds: 30,      // Delay before first check
      periodSeconds: 10,            // How often to check
      timeoutSeconds: 5,            // Request timeout
      failureThreshold: 3,          // Failures before marking unhealthy
      successThreshold: 1,          // Successes before marking healthy
      enableLiveness: true,         // Enable liveness probe
      enableReadiness: true,        // Enable readiness probe
      enableStartup: false,         // Enable startup probe
      expectedStatus: "UP",         // Expected status in response
      httpHeaders: [                // Custom headers to send
        {
          name: "X-Health-Check",
          value: "k8s"
        }
      ]
    }
  }
}
```

### Health Check Types

#### Liveness Probe
- **Purpose**: Determines if the container is still running
- **Failure Action**: Kubernetes restarts the container
- **Use Case**: Detect deadlocks or crashes

#### Readiness Probe
- **Purpose**: Determines if the container is ready to serve traffic
- **Failure Action**: Removes pod from service endpoints
- **Use Case**: Wait for dependencies or initialization

#### Startup Probe
- **Purpose**: Determines if the container has started successfully
- **Failure Action**: Kubernetes kills the container if startup fails
- **Use Case**: Slow-starting containers that need extra time

### Status Values

- **UP**: Service is healthy and operational
- **DOWN**: Service is unhealthy and not operational
- **UNKNOWN**: Health status cannot be determined
- **OUT_OF_SERVICE**: Service is temporarily out of service

### Debugging Health Checks

1. **Check pod events**: `kubectl describe pod <pod-name>`
2. **View health check logs**: `kubectl logs <pod-name>`
3. **Test endpoint manually**: `kubectl port-forward` and curl
4. **Monitor metrics**: Check health check success rates

### Performance Considerations

- Cache health check results briefly to avoid overloading dependencies
- Use circuit breakers for external service checks
- Implement graceful degradation for non-critical components
- Monitor health check execution time and optimize slow checks

## Integration with Monitoring

### Prometheus Metrics
Export health check metrics for monitoring:

```typescript
// Example metrics to track
healthcheck_total{status="success|failure"}
healthcheck_duration_seconds
healthcheck_component_status{component="database|cache|api"}
```

### Alerting Rules
Set up alerts for:
- Persistent health check failures
- High health check response times
- Critical component failures
- Service degradation patterns
