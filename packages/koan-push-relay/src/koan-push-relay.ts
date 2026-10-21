import type { Deployed } from "@jaritanet/k8s";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { VERSIONS } from "./versions.ts";

const HTTP_PORT = 8080;
const METRICS_PORT = 9090;
const CONFIG_DIR = "/etc/koan-push-relay";
const DATA_DIR = "/data";
/** distroless `nonroot`. */
const UID = 65532;

/**
 * kōan's push relay: forwards pushes to the iOS app for servers that do not
 * hold Apple's key. Specified in the koan repository, at
 * `docs/reference/protocol/push-relay.md`.
 *
 * Not `createService`, which has no way to hand a container a secret file and
 * leaves service links on. The relay reads its configuration from a TOML file;
 * every value in it is either a fact about this deployment or a credential, so
 * the whole file is one Secret rather than a ConfigMap with holes in it.
 *
 * One replica, replaced rather than rolled: the revocation table is a SQLite
 * file with one writer, and two pods sharing it during a rollout would be two.
 * Its directory is on the node the relay is pinned to, so the table survives a
 * restart; losing it would bring back every handle a device has revoked.
 */
export function createKoanPushRelay(
  provider: k8s.Provider,
  name: string,
  opts: {
    hostname?: string;
    /** The node holding the revocation table. */
    node: string;
    /** Apple's team, and the key the relay signs its provider tokens with. */
    apns: { teamId: string; keyId: string; key: pulumi.Input<string> };
  },
): Deployed {
  // Generated once and kept in state. The token key is never rotated: the
  // revocation table is keyed by it. A new handle key is a rotation (add it,
  // make it current, drop the old one after the handle lifetime), not a
  // replacement of this one.
  //
  // NB: random.* resources use the default provider.
  const tokenKey = new random.RandomBytes(`${name}-token-key`, { length: 32 });
  const handleKey = new random.RandomBytes(`${name}-handle-key-1`, {
    length: 32,
  });

  const gateway = (key: string) =>
    [`key_id = "${opts.apns.keyId}"`, `key_path = "${CONFIG_DIR}/${key}"`].join(
      "\n",
    );

  // Traefik is the only way in (see the NetworkPolicy), and it overwrites
  // X-Real-Ip with the address it saw, which Xray's PROXY header carries, on
  // every request from an untrusted source: the header holds the caller alone.
  const config = pulumi.interpolate`listen = "0.0.0.0:${HTTP_PORT}"
metrics_listen = "0.0.0.0:${METRICS_PORT}"
client_ip_header = "x-real-ip"
client_ip_hops = 1
store = "${DATA_DIR}/relay.db"
topic = "cc.blit.koan"
token_key = "${tokenKey.base64}"

[handles]
current = 1
keys = { "1" = "${handleKey.base64}" }

[apns]
team_id = "${opts.apns.teamId}"

[apns.production]
${gateway("apns.p8")}

[apns.sandbox]
${gateway("apns.p8")}
`;

  const secret = new k8s.core.v1.Secret(
    `${name}-config`,
    {
      metadata: { name: `${name}-config` },
      stringData: {
        "relay.toml": pulumi.secret(config),
        "apns.p8": pulumi.secret(opts.apns.key),
      },
    },
    { provider },
  );

  const labels = { app: name };

  new k8s.apps.v1.Deployment(
    `${name}-deployment`,
    {
      metadata: { name },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            annotations: {
              "prometheus.io/scrape": "true",
              "prometheus.io/port": `${METRICS_PORT}`,
              "prometheus.io/path": "/metrics",
              // A changed config restarts the pod; the relay reads it once.
              "jaritanet.radiosilence.dev/config":
                secret.metadata.resourceVersion,
            },
          },
          spec: {
            automountServiceAccountToken: false,
            // A Service named after the relay would inject KOAN_RELAY_*
            // variables, which is the relay's own configuration prefix.
            enableServiceLinks: false,
            nodeSelector: { "kubernetes.io/hostname": opts.node },
            securityContext: {
              runAsUser: UID,
              runAsGroup: UID,
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
            },
            // The kubelet creates a missing hostPath directory as root.
            initContainers: [
              {
                name: "own-data",
                image: "busybox:1.37",
                command: ["chown", `${UID}:${UID}`, DATA_DIR],
                securityContext: {
                  runAsUser: 0,
                  runAsNonRoot: false,
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"], add: ["CHOWN"] },
                },
                volumeMounts: [{ name: "data", mountPath: DATA_DIR }],
              },
            ],
            containers: [
              {
                name,
                image: `ghcr.io/radiosilence/koan-push-relay:${VERSIONS.koanPushRelay}`,
                env: [
                  {
                    name: "KOAN_RELAY_CONFIG",
                    value: `${CONFIG_DIR}/relay.toml`,
                  },
                ],
                ports: [
                  { name: "http", containerPort: HTTP_PORT },
                  { name: "metrics", containerPort: METRICS_PORT },
                ],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: METRICS_PORT },
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/healthz", port: METRICS_PORT },
                  periodSeconds: 30,
                  failureThreshold: 3,
                },
                resources: {
                  requests: { cpu: "50m", memory: "64Mi" },
                  limits: { memory: "1Gi" },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                volumeMounts: [
                  { name: "config", mountPath: CONFIG_DIR, readOnly: true },
                  { name: "data", mountPath: DATA_DIR },
                ],
              },
            ],
            volumes: [
              {
                name: "config",
                secret: {
                  secretName: secret.metadata.name,
                  defaultMode: 0o440,
                },
              },
              {
                name: "data",
                hostPath: {
                  path: `/var/lib/${name}`,
                  type: "DirectoryOrCreate",
                },
              },
            ],
          },
        },
      },
    },
    { provider },
  );

  new k8s.core.v1.Service(
    `${name}-service`,
    {
      metadata: { name: `${name}-service` },
      spec: {
        selector: labels,
        ports: [{ protocol: "TCP", port: 80, targetPort: HTTP_PORT }],
      },
    },
    { provider },
  );

  // The relay trusts the caller address Traefik writes, so nothing else may
  // reach its HTTP port: a pod that could would choose its own address and
  // its own quota. Metrics are scraped by vmagent from the host network.
  new k8s.networking.v1.NetworkPolicy(
    `${name}-netpol`,
    {
      metadata: { name },
      spec: {
        podSelector: { matchLabels: labels },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {},
                podSelector: {
                  matchLabels: { "app.kubernetes.io/name": "traefik" },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: HTTP_PORT }],
          },
          { ports: [{ protocol: "TCP", port: METRICS_PORT }] },
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
          // Apple's gateways, on 443. Their addresses are not published as a
          // stable list, so this is the internet on that port.
          {
            to: [
              {
                ipBlock: {
                  cidr: "0.0.0.0/0",
                  except: [
                    "10.0.0.0/8",
                    "172.16.0.0/12",
                    "192.168.0.0/16",
                    "169.254.0.0/16",
                    "100.64.0.0/10",
                  ],
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 443 }],
          },
        ],
      },
    },
    { provider },
  );

  return {
    routes: opts.hostname ? [{ service: name, hostname: opts.hostname }] : [],
  };
}
