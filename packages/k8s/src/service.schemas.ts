import * as z from "zod";
import { HealthCheckConfigSchema } from "./healthcheck.schemas.ts";
import {
  ImageSchema,
  PersistenceSchema,
  ResourcesSchema,
  StrategySchema,
} from "./schemas.ts";

/**
 * Strict, because Zod strips unknown keys in silence. A `nodeSelector` once sat
 * in a service's arguments for months doing nothing, reading as a node pin
 * while the pinning came from `nodeAffinityHostname` on its volumes. A key
 * nobody reads should fail the preview, not survive as a comment that lies.
 */
export const ServiceArgsSchema = z.strictObject({
  healthCheck: HealthCheckConfigSchema.optional(),
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
   * Also restrict *ingress* to Traefik, on top of `networkPolicy`.
   *
   * Separate from `networkPolicy` because the risk is different in kind. Egress
   * rules cannot break a pod that is already serving; an ingress rule can, if
   * the CNI also drops the kubelet's health probes — which arrive from the node
   * rather than from a pod — and the pod is then killed for failing readiness.
   * Cilium's `allow-localhost` default admits the local host to its own
   * endpoints whatever the policy says, so probes need no rule. CIDR selectors
   * do not match nodes while `policy-cidr-match-mode` is unset, so a node is
   * never admitted by address.
   *
   * `files` is the canary for this under Cilium.
   *
   * What it would buy: a compromised pod cannot reach a sibling. That is the
   * lateral step after any egress control fails, and pod-to-pod is wide open.
   */
  restrictIngress: z.boolean().default(false),
  image: ImageSchema,
  resources: ResourcesSchema.optional(),
  persistence: z.array(PersistenceSchema).default([]),
  replicas: z.uint32().default(1),
  strategy: StrategySchema.optional(),
});
