import * as z from "zod";
import { HealthCheckConfigSchema } from "./healthcheck.schemas.ts";
import {
  HostVolumeSchema,
  ImageSchema,
  LimitsSchema,
  PersistenceSchema,
  SecurityContextSchema,
  StrategySchema,
} from "./schemas.ts";

export const ServiceArgsSchema = z.object({
  /**
   * Drop every Linux capability from the container.
   *
   * Off by default rather than always-on because dropping ALL takes
   * NET_BIND_SERVICE with it, and an image serving on `:80` *inside* the
   * container needs that to bind. Safe for anything listening above 1024.
   */
  dropCapabilities: z.boolean().default(false),
  env: z.record(z.string(), z.string()).default({}),
  healthCheck: HealthCheckConfigSchema.optional(),
  hostVolumes: z.array(HostVolumeSchema).default([]),
  httpPort: z.uint32().default(80),
  /**
   * Confine the pod's egress to DNS and the public internet — no private
   * space, so it cannot reach the node, the LAN, the tailnet, other pods or
   * the API server.
   *
   * This is the control that decides what an RCE in a public-facing service
   * is worth. A read-only volumeMount protects the path it covers and nothing
   * else; unrestricted egress lets a compromised pod walk to whatever the host
   * happens to be serving and write the same data by another route.
   *
   * Ingress is deliberately left alone. Restricting it adds little (Traefik is
   * the only intended caller, and pod-to-pod reach is not the threat here)
   * while risking the classic failure where the CNI also drops the kubelet's
   * probes and the pod restart-loops.
   */
  networkPolicy: z.boolean().default(false),
  image: ImageSchema,
  limits: LimitsSchema.optional(),
  persistence: z.array(PersistenceSchema).default([]),
  ports: z.array(z.tuple([z.number(), z.number()])).default([]),
  replicas: z.uint32().default(1),
  securityContext: SecurityContextSchema.optional(),
  strategy: StrategySchema.optional(),
});
