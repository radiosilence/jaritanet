import { z } from "zod";

export const PrometheusArgsSchema = z.object({
  image: z
    .object({
      repository: z.string().default("prom/prometheus"),
      tag: z.string().default("v2.45.0"),
      pullPolicy: z.string().default("IfNotPresent"),
    })
    .default({
      repository: "prom/prometheus",
      tag: "v2.45.0",
      pullPolicy: "IfNotPresent",
    }),
  replicas: z.number().default(1),
  retention: z.string().default("15d"),
  storageSize: z.string().default("10Gi"),
  persistence: z.object({
    enabled: z.boolean().default(true),
    hostPath: z.string().default("/srv/prometheus"),
    nodeAffinityHostname: z.string(),
  }),
  resources: z
    .object({
      limits: z
        .object({
          cpu: z.string().default("1000m"),
          memory: z.string().default("2Gi"),
        })
        .default({
          cpu: "1000m",
          memory: "2Gi",
        }),
      requests: z
        .object({
          cpu: z.string().default("500m"),
          memory: z.string().default("1Gi"),
        })
        .default({
          cpu: "500m",
          memory: "1Gi",
        }),
    })
    .default({
      limits: {
        cpu: "1000m",
        memory: "2Gi",
      },
      requests: {
        cpu: "500m",
        memory: "1Gi",
      },
    }),
});
