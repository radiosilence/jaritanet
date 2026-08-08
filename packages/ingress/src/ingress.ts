import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { TraefikConfSchema } from "./ingress.schemas.ts";

/**
 * Traefik as the ingress controller, terminating TLS and routing by hostname,
 * with built-in ACME (Let's Encrypt via DNS-01 against Cloudflare).
 *
 * It binds hostPort 443 on the node, so traffic reaches it directly — the
 * cluster runs on the gateway, and a tunnel from a box to itself buys nothing.
 */
export function createIngress(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  traefik: z.infer<typeof TraefikConfSchema>,
  cloudflareApiToken: string,
) {
  // Cloudflare API token for Traefik's DNS-01 ACME solver
  const cfSecret = new k8s.core.v1.Secret(
    "cloudflare-api-token",
    {
      metadata: { name: "cloudflare-api-token" },
      stringData: {
        "api-token": cloudflareApiToken,
      },
    },
    { provider },
  );

  // Traefik via Helm — ingress controller with built-in Let's Encrypt
  const traefikRelease = new k8s.helm.v3.Release(
    "traefik",
    {
      chart: "traefik",
      // Above the 300s default, so a cold cluster pulling every image for the
      // first time isn't cut off. A timeout here fails the whole update.
      timeout: 900,
      namespace,
      repositoryOpts: {
        repo: "https://traefik.github.io/charts",
      },
      values: {
        ports: {
          web: {
            expose: { default: true },
            port: 8000,
            hostPort: 80,
          },
          websecure: {
            expose: { default: true },
            port: 8443,
            // 8443, not 443: xray owns :443 on this host and relays anything
            // that is not a VPN client to `dest` — which is this. Binding 443
            // here would collide with it and take both down. When the cluster
            // was on a different machine something had to bridge that gap; co-located,
            // the gap does not exist.
            hostPort: 8443,
          },
        },
        // Per-route request rates, response codes and latencies — the other
        // half of "is anything actually broken". The router and service labels
        // are off by default and are the whole point: without them the numbers
        // are a single total for the whole estate.
        //
        // The endpoint is on the chart's own `metrics` entrypoint (:9100 inside
        // the pod, not on the host), and the annotations are what
        // @jaritanet/metrics discovers it by. Unconditional: an unscraped
        // counter costs nothing, and gating it would put "is there a metrics
        // stack" into the config of the thing that publishes one.
        metrics: {
          prometheus: {
            addEntryPointsLabels: true,
            addRoutersLabels: true,
            addServicesLabels: true,
          },
        },
        podAnnotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9100",
        },
        service: {
          // `service.spec.type`, not `service.type` — same trap as
          // updateStrategy below. Left at the chart's LoadBalancer default it
          // never gets an address (k3s runs --disable=servicelb) and Helm waits
          // for one until it times out. hostPorts mean no load balancer is needed.
          spec: { type: "ClusterIP" },
        },
        // ACME certificate resolver using Cloudflare DNS-01
        additionalArguments: [
          `--certificatesresolvers.letsencrypt.acme.email=${traefik.acmeEmail}`,
          "--certificatesresolvers.letsencrypt.acme.storage=/data/acme.json",
          "--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare",
          "--certificatesresolvers.letsencrypt.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53",
        ],
        env: [
          {
            name: "CF_DNS_API_TOKEN",
            valueFrom: {
              secretKeyRef: {
                key: "api-token",
                name: cfSecret.metadata.name,
              },
            },
          },
        ],
        persistence: {
          enabled: true,
          size: "128Mi",
        },
        // Single node with hostPort: the replacement pod cannot bind :80/:443
        // while the old one holds them, so the chart's default (maxUnavailable
        // 0, maxSurge 1) deadlocks — the new pod stays Pending forever and the
        // old one is never allowed to leave. Traefik sat 20 days on a stale pod
        // that way, silently ignoring chart bumps.
        //
        // Old pod goes first, then the new one binds. That is a few seconds of
        // no ingress per deploy, which is the price of one node and a hostPort.
        // This key is `updateStrategy`, NOT `deployment.strategy` — the latter
        // is not in the chart's values and was accepted and ignored.
        updateStrategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
        },
        resources: {
          limits: {
            cpu: "250m",
            memory: "256Mi",
          },
        },
      },
      version: traefik.chartVersion,
    },
    { provider },
  );

  return { traefikRelease };
}

/**
 * The Traefik rule for a route: a host, and optionally a set of paths within it.
 *
 * A bare `Host()` is what almost everything wants. `paths` exists for the one
 * hostname two services share — the identity provider answers the login,
 * consent and registration endpoints on the host whose bare rule is Hydra's, so
 * the specific rule has to be preferred over the general one. Traefik derives
 * priority from rule length, which would happen to be right here and would stop
 * being right the moment a hostname got longer, so it is stated rather than
 * inherited.
 */
export function routeMatch(hostname: string, paths?: string[]) {
  const host = `Host(\`${hostname}\`)`;
  return paths?.length ? `${host} && (${paths.join(" || ")})` : host;
}

/**
 * Creates a Traefik IngressRoute for a service.
 * Each service gets its own IngressRoute CRD pointing at its K8s Service,
 * with TLS handled by the shared letsencrypt cert resolver.
 */
export function createIngressRoute(
  provider: k8s.Provider,
  serviceName: string,
  hostname: string,
  namespace: pulumi.Input<string>,
  // IngressRoute is a kind the Traefik chart installs. Without this the CRD may
  // not exist yet: "no matches for kind IngressRoute in version traefik.io/v1alpha1".
  traefik?: pulumi.Resource,
  routing?: { paths?: string[]; priority?: number },
) {
  const match = routeMatch(hostname, routing?.paths);
  // Carried by both routes: without it, two services sharing a hostname would
  // publish the same `Host()` rule on the http entrypoint and Traefik would
  // pick between two identical redirects.
  const rule = {
    kind: "Rule",
    match,
    ...(routing?.priority && { priority: routing.priority }),
  };

  new k8s.apiextensions.CustomResource(
    `${serviceName}-ingress-route`,
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: {
        name: `${serviceName}-ingress`,
        namespace,
      },
      spec: {
        entryPoints: ["websecure"],
        routes: [
          {
            ...rule,
            services: [
              {
                name: `${serviceName}-service`,
                port: 80,
              },
            ],
          },
        ],
        tls: {
          certResolver: "letsencrypt",
        },
      },
    },
    { provider, dependsOn: traefik ? [traefik] : [] },
  );

  // HTTP -> HTTPS redirect
  new k8s.apiextensions.CustomResource(
    `${serviceName}-ingress-redirect`,
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: {
        name: `${serviceName}-redirect`,
        namespace,
      },
      spec: {
        entryPoints: ["web"],
        routes: [
          {
            ...rule,
            middlewares: [
              {
                name: "redirect-https",
              },
            ],
            services: [
              {
                name: `${serviceName}-service`,
                port: 80,
              },
            ],
          },
        ],
      },
    },
    { provider, dependsOn: traefik ? [traefik] : [] },
  );
}

/**
 * Traefik Middleware for HTTP -> HTTPS redirect, shared across all services.
 */
export function createRedirectMiddleware(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  // As with IngressRoute: Middleware is a CRD the chart brings.
  traefik?: pulumi.Resource,
) {
  new k8s.apiextensions.CustomResource(
    "redirect-https",
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "Middleware",
      metadata: {
        name: "redirect-https",
        namespace,
      },
      spec: {
        redirectScheme: {
          permanent: true,
          scheme: "https",
        },
      },
    },
    { provider, dependsOn: traefik ? [traefik] : [] },
  );
}
