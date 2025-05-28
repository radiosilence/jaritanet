import { z } from "zod";

export const GrafanaDatasourceSchema = z.object({
  name: z.string().default("Prometheus"),
  type: z.string().default("prometheus"),
  url: z.string().default("http://prometheus-service:9090"),
  access: z.string().default("proxy"),
  isDefault: z.boolean().default(true),
});

export const GrafanaArgsSchema = z.object({
  image: z
    .object({
      repository: z.string().default("grafana/grafana"),
      tag: z.string().default("10.1.0"),
      pullPolicy: z.string().default("IfNotPresent"),
    })
    .default({
      repository: "grafana/grafana",
      tag: "10.1.0",
      pullPolicy: "IfNotPresent",
    }),
  replicas: z.number().default(1),
  adminUser: z.string().default("admin"),
  adminPassword: z.string().default("admin"),
  storageSize: z.string().default("5Gi"),
  persistence: z.object({
    enabled: z.boolean().default(true),
    hostPath: z.string().default("/srv/grafana"),
    nodeAffinityHostname: z.string(),
  }),
  resources: z
    .object({
      limits: z
        .object({
          cpu: z.string().default("500m"),
          memory: z.string().default("1Gi"),
        })
        .default({
          cpu: "500m",
          memory: "1Gi",
        }),
      requests: z
        .object({
          cpu: z.string().default("250m"),
          memory: z.string().default("512Mi"),
        })
        .default({
          cpu: "250m",
          memory: "512Mi",
        }),
    })
    .default({
      limits: {
        cpu: "500m",
        memory: "1Gi",
      },
      requests: {
        cpu: "250m",
        memory: "512Mi",
      },
    }),
  datasources: z.array(GrafanaDatasourceSchema).default([]),
  port: z.number().default(3000),
});
