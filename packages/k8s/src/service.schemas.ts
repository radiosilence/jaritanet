import * as z from "zod";
import { HealthCheckConfigSchema } from "./healthcheck.schemas.ts";
import {
  HostVolumeSchema,
  ImageSchema,
  PersistenceSchema,
  ResourcesSchema,
  SecurityContextSchema,
  StrategySchema,
} from "./schemas.ts";

/**
 * Strict, because Zod strips unknown keys in silence. A `nodeSelector` once sat
 * in a service's arguments for months doing nothing, reading as a node pin
 * while the pinning came from `nodeAffinityHostname` on its volumes. A key
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
   * Enforced by Cilium. `hubble_drop_total{reason="POLICY_DENIED"}` is how a
   * rule that is wrong shows up — see docs/architecture.md, Hardening notes.
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
   * `files` was enabled first, under flannel, which enforced nothing, so its
   * staying healthy then proved nothing about probes. It is the canary for
   * this under Cilium.
   *
   * What it would buy: a compromised pod cannot reach a sibling. That is the
   * lateral step after any egress control fails, and pod-to-pod is wide open.
   */
  restrictIngress: z.boolean().default(false),
  image: ImageSchema,
  resources: ResourcesSchema.optional(),
  persistence: z.array(PersistenceSchema).default([]),
  ports: z.array(z.tuple([z.number(), z.number()])).default([]),
  replicas: z.uint32().default(1),
  securityContext: SecurityContextSchema.optional(),
  strategy: StrategySchema.optional(),
});
