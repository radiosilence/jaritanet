/**
 * What this package needs from Kubernetes and hands back to whoever deploys it.
 *
 * Declared here rather than imported from a shared package, and that is the
 * point: this is a chart. It describes how to stand the gateway up and knows
 * nothing about the estate standing it up — so it depends on `@pulumi/*` and
 * `zod` and nothing else, and can be published and consumed by a deployment
 * that has never heard of jaritanet.
 *
 * The duplication is small and deliberate. A shared-primitives package would
 * have to be published too, and would make one deployment's conventions part of
 * every consumer's dependency tree.
 */
import * as z from "zod";

/** A Kubernetes resource quantity — `500m`, `2`, `64Mi`, `8Gi`. */
export const Quantity = z
  .string()
  .regex(
    /^\d+(\.\d+)?([munkMGTPE]|[KMGTPE]i)?$/,
    "must be a Kubernetes quantity, e.g. 500m, 2, 64Mi, 8Gi",
  );

export const ResourcesSchema = z.strictObject({
  cpu: Quantity.default("50m"),
  memory: Quantity.default("64Mi"),
});

/**
 * A hostname the deployment should publish, and the workload answering it.
 *
 * `service` is the name prefix: the Service is `<prefix>-service`, so a route
 * names the pair rather than either half.
 */
export type Route = {
  service: string;
  hostname: string;
  paths?: string[];
  priority?: number;
};

/**
 * The OAuth client this needs registered for it.
 *
 * Returned rather than configured, because the callback path is the gateway's
 * own and the host half comes from the hostname it was told to publish at — so
 * the redirect URI cannot name somewhere the service is not.
 */
export type OidcClient = {
  id: string;
  name: string;
  redirectUri: string;
};

/** What the deployer gets back: where this stands, and what to register. */
export type Deployed = {
  routes: Route[];
  oidc?: OidcClient;
};
