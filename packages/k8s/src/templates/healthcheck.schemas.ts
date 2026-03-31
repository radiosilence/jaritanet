import * as z from "zod";

export const HealthStatusSchema = z.enum([
  "UP",
  "DOWN",
  "UNKNOWN",
  "OUT_OF_SERVICE",
]);

export const HealthCheckConfigSchema = z.object({
  enableLiveness: z.boolean().default(true),
  enableReadiness: z.boolean().default(true),
  enableStartup: z.boolean().default(false),
  expectedStatus: HealthStatusSchema.default("UP"),
  failureThreshold: z.uint32().default(3),
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
  initialDelaySeconds: z.uint32().default(30),
  path: z.string().default("/_health"),
  periodSeconds: z.uint32().default(10),
  port: z.uint32().optional(),
  successThreshold: z.uint32().default(1),
  timeoutSeconds: z.uint32().default(5),
});
