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

/**
 * Strict, because this is written by hand in the stack file and read nowhere
 * else. `nodeSelector` sat in here for months doing nothing — Zod strips
 * unknown keys in silence, so it read as pinning navidrome to lady while the
 * pinning actually came from `nodeAffinityHostname` on the volumes below. A key
 * nobody reads should fail the preview, not survive as a comment that lies.
 */
export const ServiceArgsSchema = z.strictObject({
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
   * ⚠️ NOT CURRENTLY ENFORCED. microk8s here runs **flannel**, a pure overlay
   * with no policy engine, so these objects are accepted by the API server and
   * implemented by nothing. They are correct and latent: install an enforcing
   * CNI and they start working with no change here. Until then do not count
   * this as a control — see docs/architecture.md, Hardening notes.
   */
  networkPolicy: z.boolean().default(false),
  /**
   * Also restrict *ingress* to Traefik and the node, on top of `networkPolicy`.
   *
   * Separate from `networkPolicy` because the risk is different in kind. Egress
   * rules cannot break a pod that is already serving; an ingress rule can, if
   * the CNI also drops the kubelet's health probes — which arrive from the node
   * rather than from a pod — and the pod is then killed for failing readiness.
   * So this is opt-in per service and wants proving on something harmless.
   *
   * ⚠️ Same caveat as `networkPolicy`: flannel enforces neither. `files` staying
   * healthy after this was enabled proved nothing about probes — nothing was
   * being applied. That test has to be re-run against a real policy engine.
   *
   * What it would buy: a compromised pod cannot reach a sibling. That is the
   * lateral step after any egress control fails, and pod-to-pod is wide open.
   */
  restrictIngress: z.boolean().default(false),
  image: ImageSchema,
  limits: LimitsSchema.optional(),
  persistence: z.array(PersistenceSchema).default([]),
  ports: z.array(z.tuple([z.number(), z.number()])).default([]),
  replicas: z.uint32().default(1),
  securityContext: SecurityContextSchema.optional(),
  strategy: StrategySchema.optional(),
});
