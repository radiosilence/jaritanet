import { cpuRequests, sha256hex } from "@jaritanet/k8s";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { AuthConfSchema } from "./auth.schemas.ts";

const APP = "auth";
const REDIS = "auth-redis";
const SECRETS_NAME = "auth-secrets";

/** An env `valueFrom` pointing at a key in this component's Secret. */
const secretRef = (key: string) => ({
  valueFrom: { secretKeyRef: { name: SECRETS_NAME, key } },
});

/**
 * A relying party this deployment owns.
 *
 * The redirect URI is derived from the hostname the service already publishes
 * rather than declared, and the secret is generated rather than typed. That is
 * the whole point: the redirect allowlist is what stands between this and an
 * open redirect, and a derived list cannot hold a typo, cannot keep an entry
 * for a service whose hostname moved, and gives no service a way to widen its
 * own permissions.
 */
export type RelyingParty = {
  id: string;
  name: string;
  redirectUri: pulumi.Input<string>;
  secret: pulumi.Input<string>;
};

/**
 * The registry the provider registers with Hydra at boot.
 *
 * JSON because Pulumi already holds these as objects, so there is no format to
 * agree on and no escaping to get wrong in a value carrying client secrets.
 */
export function firstPartyClients(
  clients: { id: string; name: string; redirectUri: string; secret: string }[],
) {
  return JSON.stringify(
    clients.map((c) => ({
      id: c.id,
      name: c.name,
      secret: c.secret,
      // Exact matches only. A wildcard on a hostname is how one forgotten
      // subdomain becomes a token thief.
      redirect_uris: [c.redirectUri],
    })),
  );
}

/**
 * What this service answers on the hostname it shares with Hydra.
 *
 * One hostname, split by path, because a second `auth-something` host trades
 * one oddity for another — and `URLS_SELF_ISSUER` already stands here, so which
 * hostname issues tokens does not change, only which service answers the
 * challenges. Everything not listed stays with Hydra: `/oauth2/*`,
 * `/.well-known/*`, `/userinfo`.
 */
export function authRoutes() {
  return [
    "PathPrefix(`/auth/`)",
    "PathPrefix(`/assets/`)",
    "Path(`/`)",
    "Path(`/healthz`)",
    "Path(`/register`)",
  ];
}

/**
 * One login screen, independent of the applications it signs you into.
 *
 * Two deployments: the provider itself, and a Redis holding one nonce per login
 * in flight. Hydra is not here — it is the broker every relying party already
 * discovers, and it stays where it is deployed; this only changes which service
 * answers the login and consent challenges it delegates.
 *
 * A bespoke module rather than the generic `createService` template because it
 * needs `secretKeyRef` env and a second deployment, neither of which the
 * template supports.
 */
export function createAuth(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  conf: z.infer<typeof AuthConfSchema>,
  opts: {
    githubClientId: pulumi.Input<string>;
    githubClientSecret: pulumi.Input<string>;
    githubAllowed: pulumi.Input<string>;
    /** Cluster-internal, and never fronted by an IngressRoute. */
    hydraAdminUrl: pulumi.Input<string>;
    clients: RelyingParty[];
  },
) {
  const options = { provider };

  const registry = pulumi
    .all(
      opts.clients.map((c) =>
        pulumi
          .all([c.redirectUri, c.secret])
          .apply(([redirectUri, secret]) => ({ ...c, redirectUri, secret })),
      ),
    )
    .apply(firstPartyClients);

  const secret = new k8s.core.v1.Secret(
    "auth-secrets",
    {
      metadata: { name: SECRETS_NAME, namespace },
      stringData: {
        "gh-client-secret": pulumi.output(opts.githubClientSecret),
        "first-party-clients": registry,
      },
    },
    options,
  );

  // No volume and no persistence flags: this holds a CSRF value and a login
  // challenge per login in flight, for ten minutes, and every one of them is
  // replayable by starting the login again. Persisting it would buy nothing and
  // cost a claim that pins the one service that most wants to be movable.
  const redis = new k8s.apps.v1.Deployment(
    "auth-redis",
    {
      metadata: { name: REDIS, namespace },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: REDIS } },
        template: {
          metadata: { labels: { app: REDIS } },
          spec: {
            containers: [
              {
                name: "redis",
                image: conf.redisImage,
                // Both halves of the default persistence, off: `--save ""`
                // stops the periodic dump, `--appendonly no` the log. Otherwise
                // a container with no volume writes both to its own filesystem
                // and a slow disk stalls logins to protect data nobody wants.
                args: ["--save", "", "--appendonly", "no"],
                ports: [{ containerPort: 6379 }],
                readinessProbe: {
                  exec: { command: ["redis-cli", "ping"] },
                  initialDelaySeconds: 2,
                  periodSeconds: 10,
                },
                resources: {
                  limits: { cpu: "100m", memory: "64Mi" },
                  ...cpuRequests("100m"),
                },
                securityContext: { allowPrivilegeEscalation: false },
              },
            ],
          },
        },
      },
    },
    options,
  );

  new k8s.core.v1.Service(
    "auth-redis-service",
    {
      metadata: { name: REDIS, namespace },
      spec: {
        selector: { app: REDIS },
        ports: [{ port: 6379, targetPort: 6379 }],
      },
    },
    options,
  );

  new k8s.apps.v1.Deployment(
    "auth",
    {
      metadata: { name: APP, namespace },
      spec: {
        replicas: conf.replicas,
        selector: { matchLabels: { app: APP } },
        template: {
          metadata: {
            labels: { app: APP },
            // The registry reaches the pod as env from a Secret, which is read
            // once at start — so changing who is registered changes nothing
            // until something rolls these pods. Hashing it into the spec is
            // what makes adding a relying party take effect on the deploy that
            // adds it, rather than on the next unrelated restart. A hash, so
            // the client secrets it is derived from stay out of the pod spec.
            annotations: {
              "jaritanet.radiosilence.dev/clients": sha256hex(registry),
            },
          },
          spec: {
            containers: [
              {
                name: APP,
                image: `${conf.image.repository}:${conf.image.tag}`,
                imagePullPolicy: conf.image.pullPolicy ?? "Always",
                ports: [{ name: "http", containerPort: 8080 }],
                env: [
                  { name: "BIND_ADDR", value: "0.0.0.0:8080" },
                  { name: "PUBLIC_URL", value: `https://${conf.hostname}` },
                  // Bare service names: everything addressed here is in the
                  // same namespace as the pod resolving it, so the search path
                  // finds it and the namespace — an Output — stays out of a
                  // string built synchronously.
                  { name: "REDIS_URL", value: `redis://${REDIS}:6379` },
                  {
                    name: "HYDRA_ADMIN_URL",
                    value: pulumi.output(opts.hydraAdminUrl),
                  },
                  {
                    name: "GH_CLIENT_ID",
                    value: pulumi.output(opts.githubClientId),
                  },
                  {
                    name: "GH_CLIENT_SECRET",
                    ...secretRef("gh-client-secret"),
                  },
                  {
                    name: "GH_ALLOWED",
                    value: pulumi.output(opts.githubAllowed),
                  },
                  {
                    name: "FIRST_PARTY_CLIENTS",
                    ...secretRef("first-party-clients"),
                  },
                ],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: 8080 },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                resources: {
                  limits: conf.limits,
                  ...cpuRequests(conf.limits?.cpu),
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
          },
        },
      },
    },
    // The flow store has to answer before the first login does, and the client
    // registry has to exist before the pod that reads it.
    { dependsOn: [redis, secret], provider },
  );

  new k8s.core.v1.Service(
    "auth-service",
    {
      metadata: { name: "auth-service", namespace },
      spec: {
        selector: { app: APP },
        ports: [{ port: 80, targetPort: 8080 }],
      },
    },
    options,
  );

  // Redis holds live login flows, unauthenticated — anything that can reach it
  // can mint one and complete somebody else's sign-in.
  new k8s.networking.v1.NetworkPolicy(
    "auth-redis-netpol",
    {
      metadata: { name: REDIS, namespace },
      spec: {
        podSelector: { matchLabels: { app: REDIS } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { app: APP } } }],
            ports: [{ protocol: "TCP", port: 6379 }],
          },
        ],
      },
    },
    options,
  );
}
