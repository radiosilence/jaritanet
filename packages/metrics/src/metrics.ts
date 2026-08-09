import { resourceRequests, sha256hex } from "@jaritanet/k8s";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as yaml from "yaml";
import type * as z from "zod";
import {
  DATASOURCE_UID,
  dashboardFiles,
  HOME_DASHBOARD,
} from "./dashboards.ts";
import type { MetricsConfSchema } from "./metrics.schemas.ts";
import { scrapeConfig } from "./scrape.ts";

const VMSINGLE = "metrics-vmsingle";
const VMAGENT = "metrics-vmagent";
const NODE_EXPORTER = "metrics-node-exporter";
const SECRETS_NAME = "metrics-secrets";

/**
 * The Grafana half's service prefix.
 *
 * Exported because `createIngressRoute` derives the backend from it — a route
 * naming `metrics-grafana` reaches `metrics-grafana-service` — so the publisher
 * and the Service are the same string rather than two that agree today.
 */
export const GRAFANA = "metrics-grafana";

/** Where the provisioned dashboards are mounted, and read from. */
const DASHBOARD_DIR = "/etc/grafana/dashboards";

/** Where the store answers, in the namespace of everything that asks. */
const VMSINGLE_URL = `http://${VMSINGLE}:8428`;

/** An env `valueFrom` pointing at a key in this component's Secret. */
const secretRef = (key: string) => ({
  valueFrom: { secretKeyRef: { name: SECRETS_NAME, key } },
});

/**
 * Storage, per-node collection, and a dashboard signed in through the estate's
 * own identity provider.
 *
 * Four workloads:
 *
 *  - node-exporter — DaemonSet on every node. The host's `/proc`, `/sys` and
 *    `/` are mounted and named with `--path.*`, without which it reports the
 *    container's view of a machine nobody cares about.
 *  - vmagent — DaemonSet, each instance scraping its own node and
 *    remote-writing to the store, with a disk buffer that replays what a
 *    residential uplink dropped. See `scrapeConfig`.
 *  - vmsingle — one replica, pinned to `storageNode`, holding everything.
 *  - Grafana — an ordinary relying party of Hydra, published like any service.
 *
 * `oidc` absent deploys the first three and not Grafana. That is deliberate
 * rather than defensive: Grafana here has no local login form, so one deployed
 * without an issuer to send people to is a dashboard nobody can open — while
 * the store filling up in the meantime is worth having either way.
 */
export function createMetrics(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  conf: z.infer<typeof MetricsConfSchema>,
  oidc?: {
    /** Where the authorization server stands. Read once at the top level. */
    authHostname: string;
    clientId: pulumi.Input<string>;
    clientSecret: pulumi.Input<string>;
  },
) {
  const opts = { provider };

  // --- Storage -------------------------------------------------------------
  // Recreate, not RollingUpdate: two replicas cannot share one data directory,
  // and the replacement would sit Pending on a volume the outgoing pod holds.
  const vmsingle = new k8s.apps.v1.Deployment(
    VMSINGLE,
    {
      metadata: { name: VMSINGLE, namespace },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: VMSINGLE } },
        template: {
          metadata: { labels: { app: VMSINGLE } },
          spec: {
            automountServiceAccountToken: false,
            // The data is a directory on one machine, so the pod goes to that
            // machine. Anywhere else it would come up with an empty store and
            // report itself healthy.
            nodeSelector: { "kubernetes.io/hostname": conf.storageNode },
            containers: [
              {
                name: "vmsingle",
                image: conf.vmsingle.image,
                args: [
                  "-storageDataPath=/storage",
                  `-retentionPeriod=${conf.vmsingle.retention}`,
                  "-httpListenAddr=:8428",
                ],
                ports: [{ name: "http", containerPort: 8428 }],
                volumeMounts: [{ name: "storage", mountPath: "/storage" }],
                readinessProbe: {
                  httpGet: { path: "/health", port: 8428 },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                resources: {
                  limits: conf.vmsingle.limits,
                  ...resourceRequests(conf.vmsingle.limits),
                },
                securityContext: { allowPrivilegeEscalation: false },
              },
            ],
            volumes: [
              {
                name: "storage",
                hostPath: {
                  path: conf.vmsingle.hostPath,
                  type: "DirectoryOrCreate",
                },
              },
            ],
          },
        },
      },
    },
    { deleteBeforeReplace: true, provider },
  );

  new k8s.core.v1.Service(
    `${VMSINGLE}-service`,
    {
      metadata: { name: VMSINGLE, namespace },
      spec: {
        selector: { app: VMSINGLE },
        ports: [{ port: 8428, targetPort: 8428 }],
      },
    },
    opts,
  );

  // The write endpoint takes anything it is sent and authenticates nothing, so
  // what may reach it is the whole of its access control.
  new k8s.networking.v1.NetworkPolicy(
    `${VMSINGLE}-netpol`,
    {
      metadata: { name: VMSINGLE, namespace },
      spec: {
        podSelector: { matchLabels: { app: VMSINGLE } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              { podSelector: { matchLabels: { app: VMAGENT } } },
              { podSelector: { matchLabels: { app: GRAFANA } } },
            ],
            ports: [{ protocol: "TCP", port: 8428 }],
          },
        ],
      },
    },
    opts,
  );

  // --- node-exporter -------------------------------------------------------
  new k8s.apps.v1.DaemonSet(
    NODE_EXPORTER,
    {
      metadata: { name: NODE_EXPORTER, namespace },
      spec: {
        selector: { matchLabels: { app: NODE_EXPORTER } },
        template: {
          metadata: { labels: { app: NODE_EXPORTER } },
          spec: {
            // It reports on the host: its interfaces, its mounts, its disks.
            // In a pod network namespace the netdev collector describes a veth
            // pair and nothing else.
            hostNetwork: true,
            dnsPolicy: "ClusterFirstWithHostNet",
            automountServiceAccountToken: false,
            // Every node, including one that arrives tainted later. A machine
            // with no exporter is a machine with no history, which is the
            // failure this exists to end.
            tolerations: [{ operator: "Exists" }],
            containers: [
              {
                name: "node-exporter",
                image: conf.nodeExporter.image,
                args: [
                  "--path.procfs=/host/proc",
                  "--path.sysfs=/host/sys",
                  // Without this the filesystem collector reports the
                  // container's own overlay and none of the disks the question
                  // is about.
                  "--path.rootfs=/host/root",
                  "--web.listen-address=:9100",
                  "--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|run/credentials/.+|var/lib/kubelet/.+)($|/)",
                  "--collector.filesystem.fs-types-exclude=^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|iso9660|mqueue|nsfs|overlay|proc|procfs|pstore|rpc_pipefs|securityfs|selinuxfs|squashfs|sysfs|tracefs)$",
                ],
                ports: [{ name: "metrics", containerPort: 9100 }],
                volumeMounts: [
                  { name: "proc", mountPath: "/host/proc", readOnly: true },
                  { name: "sys", mountPath: "/host/sys", readOnly: true },
                  {
                    name: "root",
                    mountPath: "/host/root",
                    readOnly: true,
                    // A drive mounted after the pod started is invisible
                    // without this — which for the externals this exists to
                    // watch is the normal case, not an edge one.
                    mountPropagation: "HostToContainer",
                  },
                ],
                resources: {
                  limits: conf.nodeExporter.limits,
                  ...resourceRequests(conf.nodeExporter.limits),
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  seccompProfile: { type: "RuntimeDefault" },
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
            volumes: [
              { name: "proc", hostPath: { path: "/proc" } },
              { name: "sys", hostPath: { path: "/sys" } },
              { name: "root", hostPath: { path: "/" } },
            ],
          },
        },
      },
    },
    opts,
  );

  // --- vmagent -------------------------------------------------------------
  // The one workload here that talks to the API server: pod discovery, and the
  // kubelet's metrics endpoints, which authenticate the caller by token.
  const agentAccount = new k8s.core.v1.ServiceAccount(
    `${VMAGENT}-sa`,
    { metadata: { name: VMAGENT, namespace } },
    opts,
  );

  const agentRole = new k8s.rbac.v1.ClusterRole(
    `${VMAGENT}-role`,
    {
      metadata: { name: VMAGENT },
      rules: [
        {
          apiGroups: [""],
          resources: [
            "nodes",
            "nodes/metrics",
            "pods",
            "services",
            "endpoints",
          ],
          verbs: ["get", "list", "watch"],
        },
      ],
    },
    opts,
  );

  const agentBinding = new k8s.rbac.v1.ClusterRoleBinding(
    `${VMAGENT}-binding`,
    {
      metadata: { name: VMAGENT },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: agentRole.metadata.name,
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: agentAccount.metadata.name,
          namespace: pulumi.output(namespace),
        },
      ],
    },
    opts,
  );

  const scrape = scrapeConfig(conf.vmagent.scrapeInterval);
  const agentConfig = new k8s.core.v1.ConfigMap(
    `${VMAGENT}-config`,
    {
      metadata: { name: `${VMAGENT}-config`, namespace },
      data: { "scrape.yaml": scrape },
    },
    opts,
  );

  new k8s.apps.v1.DaemonSet(
    VMAGENT,
    {
      metadata: { name: VMAGENT, namespace },
      spec: {
        selector: { matchLabels: { app: VMAGENT } },
        template: {
          metadata: {
            labels: { app: VMAGENT },
            annotations: {
              // A ConfigMap edited under a running pod is invisible to a
              // process that read its config once at startup, so a changed
              // scrape config would take effect on the next unrelated restart.
              // Hashing it into the spec makes the deploy that changes it the
              // deploy that applies it.
              "jaritanet.radiosilence.dev/scrape-config": sha256hex(
                pulumi.output(scrape),
              ),
              // It reports what it managed to send and what it buffered, which
              // is the only way to tell a quiet system from a broken collector.
              "prometheus.io/scrape": "true",
              "prometheus.io/port": "8429",
            },
          },
          spec: {
            serviceAccountName: agentAccount.metadata.name,
            containers: [
              {
                name: "vmagent",
                image: conf.vmagent.image,
                args: [
                  "-promscrape.config=/config/scrape.yaml",
                  `-remoteWrite.url=${VMSINGLE_URL}/api/v1/write`,
                  "-remoteWrite.tmpDataPath=/buffer",
                  // What the home box gets to hold while its uplink is down.
                  // Beyond it the oldest blocks are dropped rather than the
                  // node's disk filling. MiB rather than MB: 512MB is below
                  // vmagent's own minimum and is rounded up with a warning.
                  "-remoteWrite.maxDiskUsagePerURL=512MiB",
                  "-httpListenAddr=:8429",
                ],
                env: [
                  {
                    name: "NODE_NAME",
                    valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } },
                  },
                  {
                    name: "NODE_IP",
                    valueFrom: { fieldRef: { fieldPath: "status.hostIP" } },
                  },
                  {
                    name: "NAMESPACE",
                    valueFrom: {
                      fieldRef: { fieldPath: "metadata.namespace" },
                    },
                  },
                ],
                ports: [{ name: "http", containerPort: 8429 }],
                volumeMounts: [
                  { name: "config", mountPath: "/config", readOnly: true },
                  { name: "buffer", mountPath: "/buffer" },
                ],
                readinessProbe: {
                  httpGet: { path: "/health", port: 8429 },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                resources: {
                  limits: conf.vmagent.limits,
                  ...resourceRequests(conf.vmagent.limits),
                },
                securityContext: { allowPrivilegeEscalation: false },
              },
            ],
            volumes: [
              {
                name: "config",
                configMap: { name: agentConfig.metadata.name },
              },
              // The buffer covers an uplink outage, not a reboot. Making it
              // durable would pin the one workload here that should be able to
              // land on any node.
              { name: "buffer", emptyDir: {} },
            ],
          },
        },
      },
    },
    { dependsOn: [agentBinding, vmsingle], provider },
  );

  if (!oidc || conf.hostname === "") return;

  // --- Grafana -------------------------------------------------------------
  // Bootstrap admin, generated. The login form is disabled below, so nothing
  // reaches this over HTTP — it exists because Grafana creates that account
  // regardless, and `admin` is otherwise its password. Recovery, if the issuer
  // is ever down, is `grafana-cli admin reset-admin-password` in the pod.
  const adminPassword = new random.RandomPassword("metrics-grafana-admin", {
    length: 32,
    special: false,
  });

  const secret = new k8s.core.v1.Secret(
    SECRETS_NAME,
    {
      metadata: { name: SECRETS_NAME, namespace },
      stringData: {
        "admin-password": adminPassword.result,
        "oidc-client-secret": pulumi.output(oidc.clientSecret),
      },
    },
    opts,
  );

  const provisioning = new k8s.core.v1.ConfigMap(
    `${GRAFANA}-provisioning`,
    {
      metadata: { name: `${GRAFANA}-provisioning`, namespace },
      data: {
        "datasource.yaml": yaml.stringify({
          apiVersion: 1,
          datasources: [
            {
              name: "VictoriaMetrics",
              // Prometheus, because that is the API it speaks — every
              // expression and every published dashboard works unchanged.
              type: "prometheus",
              uid: DATASOURCE_UID,
              access: "proxy",
              url: VMSINGLE_URL,
              isDefault: true,
              jsonData: { timeInterval: conf.vmagent.scrapeInterval },
            },
          ],
        }),
        "dashboards.yaml": yaml.stringify({
          apiVersion: 1,
          providers: [
            {
              name: "jaritanet",
              type: "file",
              // Read-only would stop anyone editing a panel to try something.
              // These are rebuilt from the ConfigMap on every start, so an edit
              // survives until the next deploy — which is the right lifetime
              // for an experiment.
              allowUiUpdates: true,
              options: { path: DASHBOARD_DIR },
            },
          ],
        }),
      },
    },
    opts,
  );

  const dashboards = new k8s.core.v1.ConfigMap(
    `${GRAFANA}-dashboards`,
    {
      metadata: { name: `${GRAFANA}-dashboards`, namespace },
      data: dashboardFiles(),
    },
    opts,
  );

  // Hydra's public API. `generic_oauth` has no discovery field, so the three
  // endpoints are named rather than found — all on the bare `Host()` rule the
  // authorization server already answers, so nothing about routing changes.
  const issuer = `https://${oidc.authHostname}`;

  new k8s.apps.v1.Deployment(
    GRAFANA,
    {
      metadata: { name: GRAFANA, namespace },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: GRAFANA } },
        template: {
          metadata: {
            labels: { app: GRAFANA },
            annotations: {
              "jaritanet.radiosilence.dev/dashboards": sha256hex(
                pulumi.output(JSON.stringify(dashboardFiles())),
              ),
            },
          },
          spec: {
            automountServiceAccountToken: false,
            nodeSelector: { "kubernetes.io/hostname": conf.storageNode },
            // The image runs as uid 472 against a directory `DirectoryOrCreate`
            // has just made for root. fsGroup is not the answer: kubelet does
            // not apply it to a hostPath volume.
            initContainers: [
              {
                name: "fix-ownership",
                image: "busybox:1.37",
                command: [
                  "sh",
                  "-c",
                  "find /var/lib/grafana ! -user 472 -exec chown 472:472 {} +",
                ],
                securityContext: {
                  runAsUser: 0,
                  allowPrivilegeEscalation: false,
                },
                volumeMounts: [{ name: "data", mountPath: "/var/lib/grafana" }],
              },
            ],
            containers: [
              {
                name: "grafana",
                image: conf.grafana.image,
                ports: [{ name: "http", containerPort: 3000 }],
                env: [
                  // Grafana builds its own `redirect_uri` from this, and the
                  // client registration allows exactly one URI. Left at the
                  // default it produces one Hydra refuses — and the refusal
                  // surfaces at Hydra, which is a confusing place to meet it.
                  {
                    name: "GF_SERVER_ROOT_URL",
                    value: `https://${conf.hostname}`,
                  },
                  // The one that fails silently. Grafana's username/password
                  // form is entirely independent of OIDC, so leaving it up
                  // makes "gated by the identity provider" mean a door with a
                  // window beside it.
                  { name: "GF_AUTH_DISABLE_LOGIN_FORM", value: "true" },
                  { name: "GF_USERS_ALLOW_SIGN_UP", value: "false" },
                  {
                    name: "GF_SECURITY_ADMIN_PASSWORD",
                    ...secretRef("admin-password"),
                  },
                  { name: "GF_AUTH_GENERIC_OAUTH_ENABLED", value: "true" },
                  { name: "GF_AUTH_GENERIC_OAUTH_NAME", value: "jaritanet" },
                  // No button to press: with no local form there is nothing
                  // else on that page to choose.
                  { name: "GF_AUTH_GENERIC_OAUTH_AUTO_LOGIN", value: "true" },
                  {
                    name: "GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP",
                    value: "true",
                  },
                  { name: "GF_AUTH_GENERIC_OAUTH_USE_PKCE", value: "true" },
                  {
                    name: "GF_AUTH_GENERIC_OAUTH_SCOPES",
                    value: "openid profile email",
                  },
                  {
                    name: "GF_AUTH_GENERIC_OAUTH_AUTH_URL",
                    value: `${issuer}/oauth2/auth`,
                  },
                  {
                    name: "GF_AUTH_GENERIC_OAUTH_TOKEN_URL",
                    value: `${issuer}/oauth2/token`,
                  },
                  {
                    name: "GF_AUTH_GENERIC_OAUTH_API_URL",
                    value: `${issuer}/userinfo`,
                  },
                  // A constant, not a JMESPath over a claim. Everyone who can
                  // reach the issuer at all is in `auth.github.allowed`, and a
                  // role expression that evaluates to nothing silently hands
                  // out `auto_assign_org_role` instead — which is a widening
                  // that looks like it worked.
                  {
                    name: "GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH",
                    value: "'Admin'",
                  },
                  {
                    name: "GF_AUTH_GENERIC_OAUTH_CLIENT_ID",
                    value: pulumi.output(oidc.clientId),
                  },
                  {
                    name: "GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET",
                    ...secretRef("oidc-client-secret"),
                  },
                  { name: "GF_ANALYTICS_REPORTING_ENABLED", value: "false" },
                  { name: "GF_ANALYTICS_CHECK_FOR_UPDATES", value: "false" },
                  // Grafana's default landing page is its own onboarding: a
                  // "set up your first data source" walkthrough for things that
                  // were set up by the deploy, and a feed of its company blog.
                  // Land on the graphs the estate exists to show instead —
                  // disks, because a drive filling up is the question this was
                  // built to answer.
                  {
                    name: "GF_USERS_DEFAULT_HOME_DASHBOARD_PATH",
                    value: `${DASHBOARD_DIR}/${HOME_DASHBOARD}.json`,
                  },
                  { name: "GF_NEWS_NEWS_FEED_ENABLED", value: "false" },
                ],
                volumeMounts: [
                  { name: "data", mountPath: "/var/lib/grafana" },
                  {
                    name: "provisioning",
                    mountPath:
                      "/etc/grafana/provisioning/datasources/datasource.yaml",
                    subPath: "datasource.yaml",
                    readOnly: true,
                  },
                  {
                    name: "provisioning",
                    mountPath:
                      "/etc/grafana/provisioning/dashboards/dashboards.yaml",
                    subPath: "dashboards.yaml",
                    readOnly: true,
                  },
                  {
                    name: "dashboards",
                    mountPath: DASHBOARD_DIR,
                    readOnly: true,
                  },
                ],
                readinessProbe: {
                  httpGet: { path: "/api/health", port: 3000 },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                resources: {
                  limits: conf.grafana.limits,
                  ...resourceRequests(conf.grafana.limits),
                },
                securityContext: { allowPrivilegeEscalation: false },
              },
            ],
            volumes: [
              {
                name: "data",
                hostPath: {
                  path: conf.grafana.hostPath,
                  type: "DirectoryOrCreate",
                },
              },
              {
                name: "provisioning",
                configMap: { name: provisioning.metadata.name },
              },
              {
                name: "dashboards",
                configMap: { name: dashboards.metadata.name },
              },
            ],
          },
        },
      },
    },
    { deleteBeforeReplace: true, dependsOn: [secret, vmsingle], provider },
  );

  new k8s.core.v1.Service(
    `${GRAFANA}-service`,
    {
      metadata: { name: `${GRAFANA}-service`, namespace },
      spec: {
        selector: { app: GRAFANA },
        ports: [{ port: 80, targetPort: 3000 }],
      },
    },
    opts,
  );
}
