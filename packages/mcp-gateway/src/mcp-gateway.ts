import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as yaml from "yaml";
import type * as z from "zod";
import type { McpGatewayConfSchema } from "./mcp-gateway.schemas.ts";
import { cpuRequests } from "@jaritanet/k8s";

const SECRETS_NAME = "mcp-gateway-secrets";
/** An env `valueFrom` pointing at a key in the stack's Secret. */
const secretRef = (key: string) => ({
  valueFrom: { secretKeyRef: { name: SECRETS_NAME, key } },
});

/**
 * The registry the gateway boots from: which MCPs it fronts, what each one is
 * called, and what it needs from the user.
 *
 * Keys are snake_case because this is the gateway's format, not ours. Backend
 * URLs are derived from the Services declared beside them, so config says which
 * MCPs exist and never where they live.
 *
 * Handed over whole in an env var rather than mounted as a file: a ConfigMap
 * edited under a running pod is invisible to it, whereas env is part of the pod
 * spec, so changing an MCP rolls the gateway onto it.
 */
/**
 * Bare service name rather than an FQDN: everything addressed here lives in the
 * same namespace as the pod doing the lookup, so the search path resolves it.
 * It also keeps the namespace out of eagerly-built strings — it is an Output,
 * and the registry YAML is assembled synchronously, so interpolating it there
 * silently embedded Pulumi's "cannot call toString on an Output" error into the
 * Postgres DSN.
 */
const sameNamespaceDns = (name: string) => name;

export function mcpRegistry(
  mcps: z.infer<typeof McpGatewayConfSchema>["mcps"],
  svcDns: (name: string) => string,
) {
  return yaml.stringify(
    mcps.map((m) => {
      const url = (path: string) =>
        `http://${svcDns(`mcp-gateway-mcp-${m.id}`)}:${m.port}${path}`;
      return {
        id: m.id,
        name: m.name,
        backend: url(m.path),
        ...(m.public && { public: true }),
        ...(m.credentialHeader && { credential_header: m.credentialHeader }),
        ...(m.fields?.length && {
          fields: m.fields.map((f) => ({
            id: f.id,
            label: f.label,
            header: f.header,
            ...(f.secret !== undefined && { secret: f.secret }),
            ...(f.default && { default: f.default }),
            ...(f.hint && { hint: f.hint }),
            ...(f.required !== undefined && { required: f.required }),
            ...(f.optionsQuery && { options_query: f.optionsQuery }),
            ...(f.syncMutation && { sync_mutation: f.syncMutation }),
          })),
        }),
        ...(m.graphqlPath && { graphql: url(m.graphqlPath) }),
        ...(m.keyHelpUrl && { key_help_url: m.keyHelpUrl }),
        ...(m.keyHint && { key_hint: m.keyHint }),
        ...(m.verify && { verify: m.verify }),
      };
    }),
  );
}

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
  namespace: pulumi.Input<string>,
  conf: z.infer<typeof McpGatewayConfSchema>,
  secrets: {
    githubClientId: pulumi.Input<string>;
    githubClientSecret: pulumi.Input<string>;
    githubAllowed: pulumi.Input<string>;
    /**
     * Where the authorization server stands, and where the identity provider
     * answers its challenges — the same hostname, split by path.
     *
     * An argument rather than this component's config: it is one address read
     * once at the top level and handed to everything that needs it, the shape
     * `vpnEntryLabel` uses so two readers cannot disagree about it. Hydra is
     * deployed here for historical reasons; the login screen is not this
     * gateway's to name.
     */
    authHostname: string;
  },
) {
  const opts = { provider };

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

  // One instance, two databases: the gateway's vault and Hydra's. They share it
  // deliberately — the two must agree on who a subject is, and a second
  // datastore would be a second thing to back up for three tables.
  const pgUser = "mcpgw";
  const pgDb = "mcp_gateway";
  const pgHost = "mcp-gateway-postgres";
  const databaseUrl = pulumi.interpolate`postgres://${pgUser}:${pgPassword.result}@${sameNamespaceDns(pgHost)}:5432/${pgDb}`;
  const hydraDsn = pulumi.interpolate`postgres://${pgUser}:${pgPassword.result}@${sameNamespaceDns(pgHost)}:5432/hydra?sslmode=disable`;

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

  // Dynamically provisioned by the cluster's default StorageClass (on jaritanet
  // that's microk8s-hostpath, which creates the volume wherever it likes). No
  // hand-rolled PV / node pinning — these are tiny tables, we just want them to
  // persist. `undefined` storageClassName means "use the default SC".
  const pgPvc = new k8s.core.v1.PersistentVolumeClaim(
    "mcp-gateway-postgres-pvc",
    {
      metadata: { name: "mcp-gateway-postgres-pvc", namespace },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "2Gi" } },
        storageClassName: conf.postgresStorageClass,
      },
    },
    // An immutable spec change (e.g. storageClassName) forces a replace; delete
    // the old claim first, else the fixed name collides with the replacement.
    { deleteBeforeReplace: true, provider },
  );

  const pgDeploy = new k8s.apps.v1.Deployment(
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

  const migrateJob = new k8s.batch.v1.Job(
    "mcp-gateway-hydra-migrate",
    {
      metadata: {
        // Suffix ties the Job name to the secret (Jobs are immutable, so a new
        // secret forces a new Job). Lowercase it — k8s names are RFC 1123.
        name: pulumi.interpolate`mcp-gateway-hydra-migrate-${hydraSystemSecret.result.apply((s) => s.slice(0, 6).toLowerCase())}`,
        namespace,
      },
      spec: {
        backoffLimit: 5,
        template: {
          metadata: {
            // Postgres' NetworkPolicy admits app=mcp-gateway and
            // app=mcp-gateway-hydra only, and a Job's pod otherwise carries
            // nothing but job-name and controller-uid. Without this the
            // migration is dropped rather than refused, so it presents as a
            // dial timeout to a Service that plainly has endpoints. It went
            // unnoticed while the cluster ran flannel, which enforces no
            // policy at all; Cilium does.
            labels: { app: "mcp-gateway-hydra" },
          },
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
    // Needs Postgres reachable (readinessProbe = pg_isready) before it can run
    // the Hydra schema migration.
    { dependsOn: [secret, pgDeploy], provider },
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
                    value: `https://${secrets.authHostname}`,
                  },
                  // Delegated to the identity provider rather than to this
                  // gateway. Hydra takes one login provider for the whole
                  // authorization server, so while these pointed here, this
                  // gateway was the login screen for every client of it — and
                  // an unhealthy replica was intermittent login failures on
                  // services with nothing else to do with it. Reverting is
                  // these three values.
                  {
                    name: "URLS_LOGIN",
                    value: `https://${secrets.authHostname}/auth/login`,
                  },
                  {
                    name: "URLS_CONSENT",
                    value: `https://${secrets.authHostname}/auth/consent`,
                  },
                  {
                    name: "WEBFINGER_OIDC_DISCOVERY_CLIENT_REGISTRATION_URL",
                    value: `https://${secrets.authHostname}/register`,
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
    // Serve only after the schema migration has completed.
    { dependsOn: [migrateJob], provider },
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
  for (const b of conf.mcps) {
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

  // --- Gateway (the Rust app) ---
  new k8s.apps.v1.Deployment(
    "mcp-gateway",
    {
      metadata: { name: "mcp-gateway", namespace },
      spec: {
        replicas: conf.replicas,
        selector: { matchLabels: { app: "mcp-gateway" } },
        template: {
          metadata: { labels: { app: "mcp-gateway" } },
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
                    value: `https://${secrets.authHostname}`,
                  },
                  {
                    name: "HYDRA_ADMIN_URL",
                    value: `http://${sameNamespaceDns("mcp-gateway-hydra-admin")}:4445`,
                  },
                  {
                    name: "MCP_REGISTRY",
                    value: mcpRegistry(conf.mcps, sameNamespaceDns),
                  },
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
                readinessProbe: {
                  httpGet: { path: "/healthz", port: 8080 },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                resources: {
                  limits: conf.limits,
                  ...cpuRequests(conf.limits?.cpu),
                },
                securityContext: { allowPrivilegeEscalation: false },
              },
            ],
          },
        },
      },
    },
    // The gateway's own tables live in the same Postgres; wait for it.
    { dependsOn: [pgDeploy], provider },
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
