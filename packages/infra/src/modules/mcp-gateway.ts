import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { McpGatewayConfSchema } from "../conf.schemas.ts";

const SECRETS_NAME = "mcp-gateway-secrets";
/** An env `valueFrom` pointing at a key in the stack's Secret. */
const secretRef = (key: string) => ({
  valueFrom: { secretKeyRef: { name: SECRETS_NAME, key } },
});

/**
 * The MCP Gateway stack: an OAuth-fronted gateway for self-hosted MCP servers.
 *
 * Three deployments in one namespace, wired together:
 *  - postgres      — one instance, two DBs (gateway + hydra), hostPath PV.
 *  - hydra         — Ory Hydra (the OAuth AS). A migrate Job runs first. Its
 *                    public API is exposed at the auth hostname; admin is
 *                    in-cluster only.
 *  - gateway       — the Rust axum app: OAuth resource server + credential vault
 *                    + dashboard, routing /<id> to each backend MCP.
 *  - backends      — one Deployment per registered MCP (e.g. fastmail-cli
 *                    mcp --http), reached in-cluster; the gateway injects the
 *                    per-user credential.
 *
 * Generated secrets (Postgres password, Hydra SECRETS_SYSTEM, TOKEN_ENC_KEY)
 * never leave the cluster — created here via @pulumi/random and wired with
 * secretKeyRef. The only externally-provided secrets are the GitHub OAuth app
 * credentials (env → this module).
 *
 * This is a bespoke module (not the generic `createService` template) because it
 * needs secretKeyRef env, a migrate Job, and a ConfigMap — none of which the
 * template supports.
 */
export function createMcpGateway(
  provider: k8s.Provider,
  namespace: string,
  conf: z.infer<typeof McpGatewayConfSchema>,
  secrets: {
    githubClientId: pulumi.Input<string>;
    githubClientSecret: pulumi.Input<string>;
    githubAllowed: pulumi.Input<string>;
  },
) {
  const opts = { provider };
  const svcDns = (name: string) => `${name}.${namespace}.svc.cluster.local`;

  // --- Generated secrets ---
  // NB: random.* resources use the default provider — passing the k8s provider
  // here makes Pulumi look for `random:...` types on the k8s provider and fail
  // with "unrecognized resource type".
  const pgPassword = new random.RandomPassword("mcp-gateway-pg", {
    length: 32,
    special: false,
  });
  const hydraSystemSecret = new random.RandomPassword(
    "mcp-gateway-hydra-system",
    { length: 48, special: false },
  );
  // 32 random bytes, base64 — the token-encryption master key.
  const tokenEncKey = new random.RandomBytes("mcp-gateway-token-enc", {
    length: 32,
  });

  const pgUser = "fastmail";
  const pgDb = "fastmail_mcp";
  const pgHost = "mcp-gateway-postgres";
  const databaseUrl = pulumi.interpolate`postgres://${pgUser}:${pgPassword.result}@${svcDns(pgHost)}:5432/${pgDb}`;
  const hydraDsn = pulumi.interpolate`postgres://${pgUser}:${pgPassword.result}@${svcDns(pgHost)}:5432/hydra?sslmode=disable`;

  const secret = new k8s.core.v1.Secret(
    "mcp-gateway-secrets",
    {
      metadata: { name: "mcp-gateway-secrets", namespace },
      stringData: {
        "postgres-password": pgPassword.result,
        "database-url": databaseUrl,
        "hydra-dsn": hydraDsn,
        "hydra-system-secret": hydraSystemSecret.result,
        "token-enc-key": tokenEncKey.base64,
        "gh-client-secret": pulumi.output(secrets.githubClientSecret),
      },
    },
    opts,
  );

  // --- Postgres (one instance, hydra DB created by an initdb ConfigMap) ---
  const pgInit = new k8s.core.v1.ConfigMap(
    "mcp-gateway-postgres-initdb",
    {
      metadata: { name: "mcp-gateway-postgres-initdb", namespace },
      data: { "initdb.sql": "CREATE DATABASE hydra;\n" },
    },
    opts,
  );

  const pgPv = new k8s.core.v1.PersistentVolume(
    "mcp-gateway-postgres-pv",
    {
      spec: {
        accessModes: ["ReadWriteOnce"],
        capacity: { storage: "2Gi" },
        local: { path: conf.postgresHostPath },
        nodeAffinity: {
          required: {
            nodeSelectorTerms: [
              {
                matchExpressions: [
                  {
                    key: "kubernetes.io/hostname",
                    operator: "In",
                    values: [conf.nodeAffinityHostname],
                  },
                ],
              },
            ],
          },
        },
        persistentVolumeReclaimPolicy: "Retain",
        storageClassName: "manual",
        volumeMode: "Filesystem",
      },
    },
    opts,
  );
  const pgPvc = new k8s.core.v1.PersistentVolumeClaim(
    "mcp-gateway-postgres-pvc",
    {
      metadata: { name: "mcp-gateway-postgres-pvc", namespace },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "2Gi" } },
        storageClassName: "manual",
        volumeName: pgPv.metadata.name,
      },
    },
    opts,
  );

  new k8s.apps.v1.Deployment(
    "mcp-gateway-postgres",
    {
      metadata: { name: pgHost, namespace },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: pgHost } },
        template: {
          metadata: { labels: { app: pgHost } },
          spec: {
            containers: [
              {
                name: "postgres",
                image: "postgres:16",
                env: [
                  { name: "POSTGRES_USER", value: pgUser },
                  { name: "POSTGRES_DB", value: pgDb },
                  {
                    name: "POSTGRES_PASSWORD",
                    ...secretRef("postgres-password"),
                  },
                  { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
                ],
                ports: [{ containerPort: 5432 }],
                volumeMounts: [
                  { name: "data", mountPath: "/var/lib/postgresql/data" },
                  { name: "initdb", mountPath: "/docker-entrypoint-initdb.d" },
                ],
                readinessProbe: {
                  exec: {
                    command: ["pg_isready", "-U", pgUser, "-d", pgDb],
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 5,
                },
              },
            ],
            volumes: [
              {
                name: "data",
                persistentVolumeClaim: { claimName: pgPvc.metadata.name },
              },
              { name: "initdb", configMap: { name: pgInit.metadata.name } },
            ],
          },
        },
      },
    },
    { deleteBeforeReplace: true, provider },
  );

  new k8s.core.v1.Service(
    "mcp-gateway-postgres-service",
    {
      metadata: { name: pgHost, namespace },
      spec: {
        selector: { app: pgHost },
        ports: [{ port: 5432, targetPort: 5432 }],
      },
    },
    opts,
  );

  // --- Hydra: migrate Job, then Deployment + public/admin Services ---
  const hydraImage = `oryd/hydra:${conf.hydraTag}`;
  const hydraEnvCommon = [
    { name: "DSN", ...secretRef("hydra-dsn") },
    { name: "SECRETS_SYSTEM", ...secretRef("hydra-system-secret") },
  ];

  new k8s.batch.v1.Job(
    "mcp-gateway-hydra-migrate",
    {
      metadata: {
        name: pulumi.interpolate`mcp-gateway-hydra-migrate-${hydraSystemSecret.result.apply((s) => s.slice(0, 6))}`,
        namespace,
      },
      spec: {
        backoffLimit: 5,
        template: {
          spec: {
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "migrate",
                image: hydraImage,
                args: ["migrate", "sql", "-e", "--yes"],
                env: [{ name: "DSN", ...secretRef("hydra-dsn") }],
              },
            ],
          },
        },
      },
    },
    { dependsOn: [secret], provider },
  );

  new k8s.apps.v1.Deployment(
    "mcp-gateway-hydra",
    {
      metadata: { name: "mcp-gateway-hydra", namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "mcp-gateway-hydra" } },
        template: {
          metadata: { labels: { app: "mcp-gateway-hydra" } },
          spec: {
            containers: [
              {
                name: "hydra",
                image: hydraImage,
                args: ["serve", "all"],
                env: [
                  ...hydraEnvCommon,
                  {
                    name: "URLS_SELF_ISSUER",
                    value: `https://${conf.authHostname}`,
                  },
                  {
                    name: "URLS_LOGIN",
                    value: `https://${conf.hostname}/auth/login`,
                  },
                  {
                    name: "URLS_CONSENT",
                    value: `https://${conf.hostname}/auth/consent`,
                  },
                  {
                    name: "WEBFINGER_OIDC_DISCOVERY_CLIENT_REGISTRATION_URL",
                    value: `https://${conf.hostname}/register`,
                  },
                  { name: "SERVE_COOKIES_SAME_SITE_MODE", value: "Lax" },
                  // Traefik terminates TLS and forwards http in-cluster; trust
                  // it so Hydra treats the connection as secure (no --dev).
                  {
                    name: "SERVE_TLS_ALLOW_TERMINATION_FROM",
                    value: "0.0.0.0/0",
                  },
                  { name: "OAUTH2_EXPOSE_INTERNAL_ERRORS", value: "false" },
                ],
                ports: [
                  { name: "public", containerPort: 4444 },
                  { name: "admin", containerPort: 4445 },
                ],
                readinessProbe: {
                  httpGet: { path: "/health/ready", port: 4445 },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
              },
            ],
          },
        },
      },
    },
    { provider },
  );

  // Public API — named `<x>-service` so createIngressRoute can front it (port
  // 80 → 4444). Reached by Claude at auth.<domain>.
  new k8s.core.v1.Service(
    "mcp-gateway-hydra-public-service",
    {
      metadata: { name: "mcp-gateway-hydra-service", namespace },
      spec: {
        selector: { app: "mcp-gateway-hydra" },
        ports: [{ port: 80, targetPort: 4444 }],
      },
    },
    opts,
  );
  // Admin API — ClusterIP, internal only. NEVER fronted by an IngressRoute.
  new k8s.core.v1.Service(
    "mcp-gateway-hydra-admin-service",
    {
      metadata: { name: "mcp-gateway-hydra-admin", namespace },
      spec: {
        selector: { app: "mcp-gateway-hydra" },
        ports: [{ port: 4445, targetPort: 4445 }],
      },
    },
    opts,
  );

  // --- Backend MCPs (one Deployment + Service each) ---
  for (const b of conf.backends) {
    new k8s.apps.v1.Deployment(
      `mcp-gateway-backend-${b.id}`,
      {
        metadata: { name: `mcp-gateway-mcp-${b.id}`, namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: `mcp-gateway-mcp-${b.id}` } },
          template: {
            metadata: {
              labels: {
                app: `mcp-gateway-mcp-${b.id}`,
                "mcp-gateway/role": "backend",
              },
            },
            spec: {
              containers: [
                {
                  name: "mcp",
                  image: b.image,
                  args: b.args,
                  ports: [{ containerPort: b.port }],
                },
              ],
            },
          },
        },
      },
      opts,
    );
    new k8s.core.v1.Service(
      `mcp-gateway-backend-${b.id}-service`,
      {
        metadata: { name: `mcp-gateway-mcp-${b.id}`, namespace },
        spec: {
          selector: { app: `mcp-gateway-mcp-${b.id}` },
          ports: [{ port: b.port, targetPort: b.port }],
        },
      },
      opts,
    );
  }

  // --- MCP registry ConfigMap ---
  const registry = conf.backends.map((b) => ({
    id: b.id,
    name: b.name,
    backend: `http://${svcDns(`mcp-gateway-mcp-${b.id}`)}:${b.port}${b.path}`,
    credential_header: b.credentialHeader,
    ...(b.keyHelpUrl && { key_help_url: b.keyHelpUrl }),
    ...(b.keyHint && { key_hint: b.keyHint }),
  }));
  const registryCm = new k8s.core.v1.ConfigMap(
    "mcp-gateway-registry",
    {
      metadata: { name: "mcp-gateway-registry", namespace },
      data: { "mcps.json": JSON.stringify(registry, null, 2) },
    },
    opts,
  );

  // --- Gateway (the Rust app) ---
  new k8s.apps.v1.Deployment(
    "mcp-gateway",
    {
      metadata: { name: "mcp-gateway", namespace },
      spec: {
        replicas: conf.replicas,
        selector: { matchLabels: { app: "mcp-gateway" } },
        template: {
          metadata: {
            labels: { app: "mcp-gateway" },
            annotations: {
              // Roll when the registry changes.
              "jaritanet/registry-hash": registryCm.metadata.name,
            },
          },
          spec: {
            containers: [
              {
                name: "mcp-gateway",
                image: `${conf.image.repository}:${conf.image.tag}`,
                imagePullPolicy: conf.image.pullPolicy ?? "Always",
                ports: [{ name: "http", containerPort: 8080 }],
                env: [
                  { name: "BIND_ADDR", value: "0.0.0.0:8080" },
                  { name: "PUBLIC_URL", value: `https://${conf.hostname}` },
                  {
                    name: "HYDRA_ISSUER",
                    value: `https://${conf.authHostname}`,
                  },
                  {
                    name: "HYDRA_ADMIN_URL",
                    value: `http://${svcDns("mcp-gateway-hydra-admin")}:4445`,
                  },
                  { name: "MCP_REGISTRY", value: "/etc/mcp-gateway/mcps.json" },
                  { name: "DATABASE_URL", ...secretRef("database-url") },
                  { name: "TOKEN_ENC_KEY", ...secretRef("token-enc-key") },
                  {
                    name: "GH_CLIENT_ID",
                    value: pulumi.output(secrets.githubClientId),
                  },
                  {
                    name: "GH_CLIENT_SECRET",
                    ...secretRef("gh-client-secret"),
                  },
                  {
                    name: "GH_ALLOWED",
                    value: pulumi.output(secrets.githubAllowed),
                  },
                ],
                volumeMounts: [
                  {
                    name: "registry",
                    mountPath: "/etc/mcp-gateway",
                    readOnly: true,
                  },
                ],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: 8080 },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                resources: { limits: conf.limits },
                securityContext: { allowPrivilegeEscalation: false },
              },
            ],
            volumes: [
              {
                name: "registry",
                configMap: { name: registryCm.metadata.name },
              },
            ],
          },
        },
      },
    },
    { provider },
  );
  new k8s.core.v1.Service(
    "mcp-gateway-service",
    {
      metadata: { name: "mcp-gateway-service", namespace },
      spec: {
        selector: { app: "mcp-gateway" },
        ports: [{ port: 80, targetPort: 8080 }],
      },
    },
    opts,
  );

  // --- NetworkPolicies: lock sensitive internal pods to their callers ---
  // Backends trust the gateway-injected credential header and have no auth of
  // their own, so only the gateway may reach them.
  new k8s.networking.v1.NetworkPolicy(
    "mcp-gateway-backends-netpol",
    {
      metadata: { name: "mcp-gateway-backends", namespace },
      spec: {
        podSelector: { matchLabels: { "mcp-gateway/role": "backend" } },
        policyTypes: ["Ingress"],
        ingress: [
          { from: [{ podSelector: { matchLabels: { app: "mcp-gateway" } } }] },
        ],
      },
    },
    opts,
  );
  // Postgres holds the encrypted credential vault + Hydra's DB — only the
  // gateway and Hydra connect to it.
  new k8s.networking.v1.NetworkPolicy(
    "mcp-gateway-postgres-netpol",
    {
      metadata: { name: "mcp-gateway-postgres", namespace },
      spec: {
        podSelector: { matchLabels: { app: pgHost } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              { podSelector: { matchLabels: { app: "mcp-gateway" } } },
              { podSelector: { matchLabels: { app: "mcp-gateway-hydra" } } },
            ],
            ports: [{ protocol: "TCP", port: 5432 }],
          },
        ],
      },
    },
    opts,
  );
}
