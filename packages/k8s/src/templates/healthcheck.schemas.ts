import { z } from "zod/v4";

export const HealthStatusSchema = z.enum([
  "UP",
  "DOWN",
  "UNKNOWN",
  "OUT_OF_SERVICE",
]);

export const HealthCheckConfigSchema = z.object({
  path: z.string().default("/_health"),
  port: z.uint32().optional(),
  initialDelaySeconds: z.uint32().default(30),
  periodSeconds: z.uint32().default(10),
  timeoutSeconds: z.uint32().default(5),
  failureThreshold: z.uint32().default(3),
  successThreshold: z.uint32().default(1),
  enableLiveness: z.boolean().default(true),
  enableReadiness: z.boolean().default(true),
  enableStartup: z.boolean().default(false),
  expectedStatus: HealthStatusSchema.default("UP"),
  followRedirects: z.boolean().default(false),
  httpHeaders: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
      }),
    )
    .default([
      {
        name: "X-Health-Check",
        value: "k8s",
      },
    ]),
});
