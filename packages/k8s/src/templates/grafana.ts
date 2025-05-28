import * as k8s from "@pulumi/kubernetes";
import type { z } from "zod";
import type { GrafanaArgsSchema } from "./grafana.schemas.ts";

const annotations = {
  "pulumi.com/skipAwait": "true",
};

export function createGrafana(
  provider: k8s.Provider,
  name: string,
  args: z.infer<typeof GrafanaArgsSchema>,
) {
  // ConfigMap for Grafana datasources
  const datasourcesConfigMap = new k8s.core.v1.ConfigMap(
    `${name}-datasources`,
    {
      metadata: {
        name: `${name}-datasources`,
        annotations,
      },
      data: {
        "datasources.yaml": `
apiVersion: 1
datasources:
${args.datasources
  .map(
    (ds) => `  - name: ${ds.name}
    type: ${ds.type}
    url: ${ds.url}
    access: ${ds.access}
    isDefault: ${ds.isDefault}`,
  )
  .join("\n")}
`,
      },
    },
    { provider },
  );

  // ConfigMap for default dashboards
  const dashboardsConfigMap = new k8s.core.v1.ConfigMap(
    `${name}-dashboards`,
    {
      metadata: {
        name: `${name}-dashboards`,
        annotations,
      },
      data: {
        "dashboard-provider.yaml": `
apiVersion: 1
providers:
  - name: 'default'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    updateIntervalSeconds: 10
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
`,
        "kubernetes-overview.json": JSON.stringify({
          dashboard: {
            id: null,
            title: "Kubernetes Overview",
            tags: ["kubernetes"],
            style: "dark",
            timezone: "browser",
            panels: [
              {
                id: 1,
                title: "Node CPU Usage",
                type: "stat",
                targets: [
                  {
                    expr: '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
                    legendFormat: "CPU Usage %",
                  },
                ],
                fieldConfig: {
                  defaults: {
                    unit: "percent",
                  },
                },
                gridPos: { h: 8, w: 12, x: 0, y: 0 },
              },
              {
                id: 2,
                title: "Node Memory Usage",
                type: "stat",
                targets: [
                  {
                    expr: "100 * (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))",
                    legendFormat: "Memory Usage %",
                  },
                ],
                fieldConfig: {
                  defaults: {
                    unit: "percent",
                  },
                },
                gridPos: { h: 8, w: 12, x: 12, y: 0 },
              },
              {
                id: 3,
                title: "Pod Status",
                type: "table",
                targets: [
                  {
                    expr: "kube_pod_info",
                    format: "table",
                  },
                ],
                gridPos: { h: 8, w: 24, x: 0, y: 8 },
              },
            ],
            time: {
              from: "now-1h",
              to: "now",
            },
            refresh: "30s",
          },
        }),
        "jaritanet-services.json": JSON.stringify({
          dashboard: {
            id: null,
            title: "JaritaNet Services",
            tags: ["jaritanet"],
            style: "dark",
            timezone: "browser",
            panels: [
              {
                id: 1,
                title: "Service Health Status",
                type: "stat",
                targets: [
                  {
                    expr: 'up{job="jaritanet-services"}',
                    legendFormat: "{{kubernetes_name}}",
                  },
                ],
                gridPos: { h: 6, w: 24, x: 0, y: 0 },
              },
              {
                id: 2,
                title: "HTTP Request Rate",
                type: "graph",
                targets: [
                  {
                    expr: 'rate(http_requests_total{job="jaritanet-services"}[5m])',
                    legendFormat: "{{kubernetes_name}} - {{method}} {{status}}",
                  },
                ],
                gridPos: { h: 8, w: 12, x: 0, y: 6 },
              },
              {
                id: 3,
                title: "Response Time",
                type: "graph",
                targets: [
                  {
                    expr: 'histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="jaritanet-services"}[5m]))',
                    legendFormat: "{{kubernetes_name}} - 95th percentile",
                  },
                ],
                gridPos: { h: 8, w: 12, x: 12, y: 6 },
              },
              {
                id: 4,
                title: "Cloudflared Tunnel Status",
                type: "stat",
                targets: [
                  {
                    expr: "cloudflared_tunnel_connections",
                    legendFormat: "Active Connections",
                  },
                ],
                gridPos: { h: 6, w: 24, x: 0, y: 14 },
              },
            ],
            time: {
              from: "now-1h",
              to: "now",
            },
            refresh: "30s",
          },
        }),
      },
    },
    { provider },
  );

  // Persistent Volume for data storage
  const pv = new k8s.core.v1.PersistentVolume(
    `${name}-pv`,
    {
      metadata: {
        name: `${name}-pv`,
        annotations,
      },
      spec: {
        capacity: {
          storage: args.storageSize,
        },
        volumeMode: "Filesystem",
        accessModes: ["ReadWriteOnce"],
        persistentVolumeReclaimPolicy: "Retain",
        storageClassName: "manual",
        local: {
          path: args.persistence.hostPath,
        },
        nodeAffinity: {
          required: {
            nodeSelectorTerms: [
              {
                matchExpressions: [
                  {
                    key: "kubernetes.io/hostname",
                    operator: "In",
                    values: [args.persistence.nodeAffinityHostname],
                  },
                ],
              },
            ],
          },
        },
      },
    },
    { provider },
  );

  // Persistent Volume Claim
  const pvc = new k8s.core.v1.PersistentVolumeClaim(
    `${name}-pvc`,
    {
      metadata: {
        name: `${name}-pvc`,
        annotations,
      },
      spec: {
        storageClassName: "manual",
        volumeName: pv.metadata.name,
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: args.storageSize,
          },
        },
      },
    },
    { provider },
  );

  // Service
  const service = new k8s.core.v1.Service(
    `${name}-service`,
    {
      metadata: {
        name: `${name}-service`,
        annotations,
      },
      spec: {
        selector: { app: name },
        ports: [
          {
            name: "web",
            protocol: "TCP",
            port: args.port,
            targetPort: args.port,
          },
        ],
      },
    },
    { provider },
  );

  // Secret for admin credentials
  const secret = new k8s.core.v1.Secret(
    `${name}-secret`,
    {
      metadata: {
        name: `${name}-secret`,
        annotations,
      },
      type: "Opaque",
      stringData: {
        "admin-user": args.adminUser,
        "admin-password": args.adminPassword,
      },
    },
    { provider },
  );

  // Deployment
  new k8s.apps.v1.Deployment(
    `${name}-deployment`,
    {
      metadata: {
        name: `${name}-deployment`,
        annotations,
      },
      spec: {
        replicas: args.replicas,
        selector: {
          matchLabels: { app: name },
        },
        template: {
          metadata: {
            labels: { app: name },
            annotations,
          },
          spec: {
            securityContext: {
              fsGroup: 472,
              supplementalGroups: [0],
            },
            containers: [
              {
                name,
                image: `${args.image.repository}:${args.image.tag}`,
                imagePullPolicy: args.image.pullPolicy,
                ports: [{ name: "web", containerPort: args.port }],
                resources: args.resources,
                env: [
                  {
                    name: "GF_SECURITY_ADMIN_USER",
                    valueFrom: {
                      secretKeyRef: {
                        name: secret.metadata.name,
                        key: "admin-user",
                      },
                    },
                  },
                  {
                    name: "GF_SECURITY_ADMIN_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: secret.metadata.name,
                        key: "admin-password",
                      },
                    },
                  },
                  {
                    name: "GF_INSTALL_PLUGINS",
                    value: "grafana-clock-panel,grafana-simple-json-datasource",
                  },
                ],
                volumeMounts: [
                  {
                    name: "grafana-storage",
                    mountPath: "/var/lib/grafana",
                  },
                  {
                    name: "grafana-datasources",
                    mountPath: "/etc/grafana/provisioning/datasources",
                    readOnly: false,
                  },
                  {
                    name: "grafana-dashboards-config",
                    mountPath: "/etc/grafana/provisioning/dashboards",
                    readOnly: false,
                  },
                  {
                    name: "grafana-dashboards",
                    mountPath: "/var/lib/grafana/dashboards",
                    readOnly: false,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "grafana-storage",
                persistentVolumeClaim: {
                  claimName: pvc.metadata.name,
                },
              },
              {
                name: "grafana-datasources",
                configMap: {
                  defaultMode: 420,
                  name: datasourcesConfigMap.metadata.name,
                },
              },
              {
                name: "grafana-dashboards-config",
                configMap: {
                  defaultMode: 420,
                  name: dashboardsConfigMap.metadata.name,
                  items: [
                    {
                      key: "dashboard-provider.yaml",
                      path: "dashboard-provider.yaml",
                    },
                  ],
                },
              },
              {
                name: "grafana-dashboards",
                configMap: {
                  defaultMode: 420,
                  name: dashboardsConfigMap.metadata.name,
                  items: [
                    {
                      key: "kubernetes-overview.json",
                      path: "kubernetes-overview.json",
                    },
                    {
                      key: "jaritanet-services.json",
                      path: "jaritanet-services.json",
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
    { provider },
  );

  return service;
}
