import type { Deployed } from "@jaritanet/k8s";
import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { VERSIONS } from "./versions.ts";

const NAME = "koan";
const API_PORT = 4000;
/**
 * MCP over HTTP. It carries no credential check of its own, so the policy
 * below admits the gateway to it and nothing else.
 */
export const KOAN_INTERNAL_PORT = 8081;
const STATE = "/var/lib/koan";

/** Private and link-local space: everything the pod has no business reaching. */
const PRIVATE = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
];

/**
 * koan as a headless server over the media library: GraphQL and Subsonic at a
 * hostname of its own, and MCP for the gateway on an internal port.
 *
 * The library is mounted read-only, so nothing reached through koan can
 * change it; koan's own config, index and auth keys live in a state directory
 * on the same node. Users and the Subsonic secret are created with `koan auth
 * setup` and `koan subsonic setup` inside the pod; until then the public port
 * refuses everything.
 */
export function createKoan(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  opts: {
    hostname: string;
    node: string;
    gatewayPodLabels?: Record<string, string>;
  },
): Deployed {
  const options = { provider };
  new k8s.apps.v1.Deployment(
    "koan",
    {
      metadata: { name: NAME, namespace },
      spec: {
        replicas: 1,
        // Host paths and one index: two pods would share neither safely.
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: NAME } },
        template: {
          metadata: { labels: { app: NAME } },
          spec: {
            nodeSelector: { "kubernetes.io/hostname": opts.node },
            // The media tree is 1000:1000, readable through its group and
            // other bits; the state directory is made 1000's below.
            securityContext: {
              runAsUser: 1000,
              runAsGroup: 1000,
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
            },
            // kubelet creates a missing hostPath as root, and koan cannot
            // write what root owns. Only the state directory is mounted here.
            initContainers: [
              {
                name: "state",
                image: VERSIONS.alpine,
                command: [
                  "sh",
                  "-c",
                  `chown 1000:1000 ${STATE} && chmod 700 ${STATE}`,
                ],
                securityContext: {
                  runAsUser: 0,
                  runAsNonRoot: false,
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER"] },
                },
                resources: {
                  requests: { cpu: "5m", memory: "8Mi" },
                  limits: { memory: "32Mi" },
                },
                volumeMounts: [{ name: "state", mountPath: STATE }],
              },
            ],
            containers: [
              {
                name: NAME,
                image: VERSIONS.koan,
                args: ["--port", String(API_PORT)],
                env: [
                  { name: "KOAN_CONFIG_DIR", value: STATE },
                  {
                    name: "KOAN_MCP_BIND",
                    value: `0.0.0.0:${KOAN_INTERNAL_PORT}`,
                  },
                  // The gateway forwards each user's koan account; a request
                  // without one is refused rather than run at a default role.
                  { name: "KOAN_MCP_REQUIRE_LOGIN", value: "1" },
                  { name: "KOAN_LIBRARY__FOLDERS", value: '["/music"]' },
                  // koan refuses a Host it was not told about.
                  {
                    name: "KOAN_GRAPHQL__ALLOWED_HOSTS",
                    value: `["${opts.hostname}"]`,
                  },
                  // Served over HTTPS by Traefik.
                  { name: "KOAN_GRAPHQL__COOKIE_SECURE", value: "true" },
                  // Share links are built on the address strangers reach.
                  {
                    name: "KOAN_SHARING__PUBLIC_URL",
                    value: `https://${opts.hostname}`,
                  },
                ],
                ports: [
                  { name: "api", containerPort: API_PORT },
                  { name: "mcp", containerPort: KOAN_INTERNAL_PORT },
                ],
                readinessProbe: {
                  tcpSocket: { port: API_PORT },
                  periodSeconds: 10,
                },
                livenessProbe: {
                  tcpSocket: { port: API_PORT },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                },
                // Sized for a Subsonic client's full sync and a scan at once:
                // at one core, a syncing phone throttled every other request
                // to seconds. It inherits what Navidrome held (two cores, 4Gi)
                // on top of its own.
                resources: {
                  requests: { cpu: "250m", memory: "256Mi" },
                  limits: { cpu: "6", memory: "5Gi" },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                volumeMounts: [
                  { name: "music", mountPath: "/music", readOnly: true },
                  { name: "state", mountPath: STATE },
                  // Caches (artwork, lyrics) go under $HOME; they are
                  // rebuilt on demand, so they need not outlive the pod.
                  { name: "home", mountPath: "/home/koan" },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              {
                name: "music",
                hostPath: { path: "/mnt/kontent/music", type: "Directory" },
              },
              {
                name: "state",
                hostPath: { path: STATE, type: "DirectoryOrCreate" },
              },
              { name: "home", emptyDir: {} },
              { name: "tmp", emptyDir: {} },
            ],
          },
        },
      },
    },
    options,
  );

  new k8s.core.v1.Service(
    "koan-service",
    {
      metadata: { name: "koan-service", namespace },
      spec: {
        selector: { app: NAME },
        ports: [{ port: 80, targetPort: API_PORT }],
      },
    },
    options,
  );
  new k8s.core.v1.Service(
    "koan-internal",
    {
      metadata: { name: "koan-internal", namespace },
      spec: {
        selector: { app: NAME },
        ports: [{ port: KOAN_INTERNAL_PORT, targetPort: KOAN_INTERNAL_PORT }],
      },
    },
    options,
  );

  new k8s.networking.v1.NetworkPolicy(
    "koan-netpol",
    {
      metadata: { name: NAME, namespace },
      spec: {
        podSelector: { matchLabels: { app: NAME } },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          // GraphQL and Subsonic, through Traefik; the node for the probes.
          {
            from: [
              {
                podSelector: {
                  matchLabels: { "app.kubernetes.io/name": "traefik" },
                },
              },
              { ipBlock: { cidr: "192.168.0.0/16" } },
            ],
            ports: [{ protocol: "TCP", port: API_PORT }],
          },
          // MCP has no credential check: the gateway only.
          {
            from: [
              {
                podSelector: {
                  matchLabels: opts.gatewayPodLabels ?? { app: "mcp-gateway" },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: KOAN_INTERNAL_PORT }],
          },
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          // Artwork, lyrics and similar-artist lookups are public services;
          // nothing inside the cluster or the house is koan's business.
          { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: PRIVATE } }] },
        ],
      },
    },
    options,
  );

  // The route helper names the Service `${service}-service`.
  return { routes: [{ service: NAME, hostname: opts.hostname }] };
}
