import * as k8s from "@pulumi/kubernetes";
import type { z } from "zod";
import type { PrometheusArgsSchema } from "./prometheus.schemas.ts";

const annotations = {
  "pulumi.com/skipAwait": "true",
};

export function createPrometheus(
  provider: k8s.Provider,
  name: string,
  args: z.infer<typeof PrometheusArgsSchema>,
) {
  // ConfigMap for Prometheus configuration
  const configMap = new k8s.core.v1.ConfigMap(
    `${name}-config`,
    {
      metadata: {
        name: `${name}-config`,
        annotations,
      },
      data: {
        "prometheus.yml": `
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  # - "first_rules.yml"
  # - "second_rules.yml"

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'kubernetes-apiservers'
    kubernetes_sd_configs:
      - role: endpoints
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    relabel_configs:
      - source_labels: [__meta_kubernetes_namespace, __meta_kubernetes_service_name, __meta_kubernetes_endpoint_port_name]
        action: keep
        regex: default;kubernetes;https

  - job_name: 'kubernetes-nodes'
    kubernetes_sd_configs:
      - role: node
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    relabel_configs:
      - action: labelmap
        regex: __meta_kubernetes_node_label_(.+)
      - target_label: __address__
        replacement: kubernetes.default.svc:443
      - source_labels: [__meta_kubernetes_node_name]
        regex: (.+)
        target_label: __metrics_path__
        replacement: /api/v1/nodes/\${1}/proxy/metrics

  - job_name: 'kubernetes-cadvisor'
    kubernetes_sd_configs:
      - role: node
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    relabel_configs:
      - action: labelmap
        regex: __meta_kubernetes_node_label_(.+)
      - target_label: __address__
        replacement: kubernetes.default.svc:443
      - source_labels: [__meta_kubernetes_node_name]
        regex: (.+)
        target_label: __metrics_path__
        replacement: /api/v1/nodes/\${1}/proxy/metrics/cadvisor

  - job_name: 'kubernetes-service-endpoints'
    kubernetes_sd_configs:
      - role: endpoints
    relabel_configs:
      - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scheme]
        action: replace
        target_label: __scheme__
        regex: (https?)
      - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_service_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::[0-9]+)?;([0-9]+)
        replacement: \$1:\$2
        target_label: __address__
      - action: labelmap
        regex: __meta_kubernetes_service_label_(.+)
      - source_labels: [__meta_kubernetes_namespace]
        action: replace
        target_label: kubernetes_namespace
      - source_labels: [__meta_kubernetes_service_name]
        action: replace
        target_label: kubernetes_name

  - job_name: 'cloudflared-metrics'
    static_configs:
      - targets: ['cloudflared-service.jaritanet.svc.cluster.local:2000']
    metrics_path: /metrics

  - job_name: 'jaritanet-services'
    kubernetes_sd_configs:
      - role: endpoints
        namespaces:
          names:
            - jaritanet
    relabel_configs:
      - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scheme]
        action: replace
        target_label: __scheme__
        regex: (https?)
      - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_service_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::[0-9]+)?;([0-9]+)
        replacement: \$1:\$2
        target_label: __address__
      - action: labelmap
        regex: __meta_kubernetes_service_label_(.+)
      - source_labels: [__meta_kubernetes_namespace]
        action: replace
        target_label: kubernetes_namespace
      - source_labels: [__meta_kubernetes_service_name]
        action: replace
        target_label: kubernetes_name
`,
      },
    },
    { provider },
  );

  // Service Account
  const serviceAccount = new k8s.core.v1.ServiceAccount(
    `${name}-sa`,
    {
      metadata: {
        name: `${name}-sa`,
        annotations,
      },
    },
    { provider },
  );

  // ClusterRole
  const clusterRole = new k8s.rbac.v1.ClusterRole(
    `${name}-clusterrole`,
    {
      metadata: {
        name: `${name}-clusterrole`,
        annotations,
      },
      rules: [
        {
          apiGroups: [""],
          resources: ["nodes", "nodes/proxy", "services", "endpoints", "pods"],
          verbs: ["get", "list", "watch"],
        },
        {
          apiGroups: ["extensions"],
          resources: ["ingresses"],
          verbs: ["get", "list", "watch"],
        },
        {
          nonResourceURLs: ["/metrics"],
          verbs: ["get"],
        },
      ],
    },
    { provider },
  );

  // ClusterRoleBinding
  new k8s.rbac.v1.ClusterRoleBinding(
    `${name}-clusterrolebinding`,
    {
      metadata: {
        name: `${name}-clusterrolebinding`,
        annotations,
      },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: clusterRole.metadata.name,
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: serviceAccount.metadata.name,
          namespace: "jaritanet",
        },
      ],
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
        annotations: {
          ...annotations,
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9090",
        },
      },
      spec: {
        selector: { app: name },
        ports: [
          {
            name: "web",
            protocol: "TCP",
            port: 9090,
            targetPort: 9090,
          },
        ],
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
            serviceAccountName: serviceAccount.metadata.name,
            containers: [
              {
                name,
                image: `${args.image.repository}:${args.image.tag}`,
                imagePullPolicy: args.image.pullPolicy,
                ports: [{ name: "web", containerPort: 9090 }],
                args: [
                  "--config.file=/etc/prometheus/prometheus.yml",
                  "--storage.tsdb.path=/prometheus/",
                  "--web.console.libraries=/etc/prometheus/console_libraries",
                  "--web.console.templates=/etc/prometheus/consoles",
                  `--storage.tsdb.retention.time=${args.retention}`,
                  "--web.enable-lifecycle",
                ],
                resources: args.resources,
                volumeMounts: [
                  {
                    name: "prometheus-config-volume",
                    mountPath: "/etc/prometheus/",
                  },
                  {
                    name: "prometheus-storage-volume",
                    mountPath: "/prometheus/",
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "prometheus-config-volume",
                configMap: {
                  defaultMode: 420,
                  name: configMap.metadata.name,
                },
              },
              {
                name: "prometheus-storage-volume",
                persistentVolumeClaim: {
                  claimName: pvc.metadata.name,
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
