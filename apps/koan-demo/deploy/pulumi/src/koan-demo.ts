import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { VERSIONS } from "./versions.ts";

const NAME = "koan-demo";
const PORT = 4000;

/**
 * koan's public demo, for visitors and App Review: koan in demo mode
 * (`server.demo`, everyone signs in as demo/demo) over the music this app's
 * image holds, reset at the top of every hour.
 *
 * The reset is the container ending: koan runs under `timeout` until the
 * hour, and its state lives in the container's own writable layer rather
 * than a volume, so the restart kubelet makes starts from nothing. koan
 * indexes /music at start-up. No CronJob, so nothing needs leave to restart
 * the Deployment.
 *
 * The music is an image volume: the image's files mounted read-only, nothing
 * copied. `koanImage` is the stack's own koan pin, so the demo runs the
 * release the real server does.
 */
export function createKoanDemo(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  opts: { hostname: string; koanImage: string; node: string; cpuLimit: string },
) {
  const options = { provider };
  const labels = {
    "app.kubernetes.io/name": "koan",
    "app.kubernetes.io/instance": NAME,
  };
  const service = `${NAME}-service`;

  new k8s.apps.v1.Deployment(
    NAME,
    {
      metadata: { name: NAME, namespace, labels },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            nodeSelector: { "kubernetes.io/hostname": opts.node },
            securityContext: {
              runAsUser: 1000,
              runAsGroup: 1000,
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "koan",
                image: opts.koanImage,
                command: [
                  "sh",
                  "-c",
                  `exec timeout "$(( 3600 - $(date +%s) % 3600 ))" koan --headless --bind 0.0.0.0 --port ${PORT}`,
                ],
                env: [
                  // In the container's own layer, which the image leaves
                  // writable for its user; the image's /config is a mount point.
                  { name: "KOAN_CONFIG_DIR", value: "/home/koan/config" },
                  { name: "KOAN_SERVER__DEMO", value: "true" },
                  { name: "KOAN_SUBSONIC__ENABLED", value: "true" },
                  { name: "KOAN_LIBRARY__FOLDERS", value: '["/music"]' },
                  // The sample playlists are files in the library; this
                  // shows them to the demo account (koan 0.67.2 on).
                  { name: "KOAN_LIBRARY__PUBLIC_PLAYLISTS", value: "true" },
                  {
                    name: "KOAN_GRAPHQL__ALLOWED_HOSTS",
                    value: `["${opts.hostname}"]`,
                  },
                  { name: "KOAN_GRAPHQL__COOKIE_SECURE", value: "true" },
                  {
                    name: "KOAN_SERVER__URL",
                    value: `https://${opts.hostname}`,
                  },
                ],
                ports: [{ name: "api", containerPort: PORT }],
                readinessProbe: {
                  tcpSocket: { port: "api" },
                  periodSeconds: 5,
                },
                resources: {
                  requests: { cpu: "50m", memory: "192Mi" },
                  limits: { cpu: opts.cpuLimit, memory: "1Gi" },
                },
                // The root filesystem is writable on purpose: it is where the
                // state lives, so that a restart discards it.
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                },
                volumeMounts: [
                  {
                    name: "music",
                    mountPath: "/music",
                    subPath: "music",
                    readOnly: true,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "music",
                image: {
                  reference: `ghcr.io/radiosilence/koan-demo:${VERSIONS.koanDemo}`,
                  pullPolicy: "IfNotPresent",
                },
              },
            ],
          },
        },
      },
    },
    // Replaced rather than patched when its volumes change: a server-side
    // patch merges a volume's new source into the old one under another
    // field manager, which the API refuses. Deleted first, as the name is the
    // same; a demo can be down for the seconds that takes.
    {
      ...options,
      replaceOnChanges: [
        "spec.template.spec.volumes",
        "spec.template.spec.initContainers",
      ],
      deleteBeforeReplace: true,
    },
  );

  new k8s.core.v1.Service(
    service,
    {
      metadata: { name: service, namespace, labels },
      spec: { selector: labels, ports: [{ port: 80, targetPort: "api" }] },
    },
    options,
  );

  // `-netpol`, the name koan's chart gave it, so it is updated in place.
  new k8s.networking.v1.NetworkPolicy(
    `${NAME}-netpol`,
    {
      metadata: { name: NAME, namespace, labels },
      spec: {
        podSelector: { matchLabels: labels },
        policyTypes: ["Ingress", "Egress"],
        // The ingress controller, and kubelet's probes. The API is public
        // anyway, so the port is open to the cluster.
        ingress: [{ ports: [{ protocol: "TCP", port: PORT }] }],
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
          // Lyrics, artist pages and the push relay: the public internet only.
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
          },
        ],
      },
    },
    options,
  );

  // Routes name a prefix; the ingress backs onto `<prefix>-service`.
  return { routes: [{ service: NAME, hostname: opts.hostname }] };
}
