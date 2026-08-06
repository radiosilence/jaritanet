import * as z from "zod";

export const HealthCheckConfigSchema = z.object({
  enableLiveness: z.boolean().default(true),
  enableReadiness: z.boolean().default(true),
  // On by default: liveness and readiness do not run until startup succeeds, so
  // a slow first boot cannot be killed before it has bound a socket. Off, a
  // service whose warm-up outlasts `initialDelaySeconds` is not merely slow to
  // arrive — it is unstartable, because every restart repeats the same warm-up
  // and is killed at the same point. blit does exactly that: nano-web spends
  // ~65s processing files under a 100m CPU limit before it listens, and the
  // liveness probe kills it at ~60s, forever.
  enableStartup: z.boolean().default(true),
  failureThreshold: z.uint32().default(3),
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
