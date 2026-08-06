import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { cpuRequests, sha256hex } from "@jaritanet/k8s";

/** An exit with its host port resolved (see deriveExitPort). */
export type ResolvedExit = {
  name: string;
  node: string;
  nodeLabel: string;
  port: number;
  method: string;
  image: string;
  server: string;
};

const LIMITS = { cpu: "500m", memory: "128Mi" };

/**
 * Deterministic host port from the exit name (djb2 → 20000–29999), so you
 * never hand-pick plumbing. Stable per name and order-independent; a config
 * `port` override wins, and main asserts the resolved set is collision-free.
 */
export function deriveExitPort(name: string): number {
  let h = 5381;
  for (const ch of name) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return 20000 + (h % 10000);
}

/**
 * A k8s egress exit: ss-rust on the node whose address the traffic should
 * leave from, reached over the tailnet by whichever entry the client picked.
 *
 * `hostNetwork` is the mechanism, not a shortcut. In the node's own namespace
 * the host stack picks the source address by routing, so nothing masquerades
 * the flow and a home node egresses its residential ISP address — the one
 * thing a datacentre range can never be. It is also what puts `tailscale0` in
 * the pod's namespace, so the port an entry dials is the node's tailnet
 * address rather than a ClusterIP the overlay would have to carry.
 *
 * A DaemonSet for the reason samba and the transports are: the host port is
 * exclusive, so two replicas can never share a node and `maxSurge: 0` follows
 * — the old pod must be gone before the replacement can bind.
 *
 * No kernel forwarding and no return-path routing on a remote box: ss-rust
 * owns both ends of every flow. An offline node is a dial that fails at a
 * named address, which is what a manually-selected exit needs — `exit-select`
 * has a human for failover, and a connection that establishes and then
 * swallows packets is the failure they read worst.
 *
 * The ss password is a single Pulumi secret consumed here (server Secret) and
 * by the client outbound (see singbox) — one source, no drift. Returns the
 * exit's coordinates for the client profile.
 */
export function createExit(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  exit: ResolvedExit,
) {
  const name = `exit-${exit.name}`;

  // The label is the switch. The DaemonSet controller watches Nodes, so this
  // patch is what schedules the exit — a labelled node grows the pod in about a
  // second, and removing the label tears it down just as fast. Declaring it here
  // rather than leaving it to a human is the difference between "the exit is on
  // lady" being a fact about the config and a fact about someone's memory: an
  // unlabelled node schedules zero pods and reports itself perfectly healthy.
  //
  // Over the Kubernetes API, not SSH — a node seeded from cloud-init has no
  // connection in this program, but it is a cluster member, which is the same
  // reach k3s upgrades use to get to it.
  //
  // patchForce is what makes this reconcile rather than merely assert. A
  // server-side apply carrying the same value co-owns the field happily, so the
  // steady state needs nothing; it is the *diverged* state that conflicts, and
  // `kubectl label` holds the field as a different manager. Without the force,
  // the one case this exists for — someone changed the label by hand — fails the
  // deploy with a field-manager conflict instead of putting it back.
  const label = new k8s.core.v1.NodePatch(
    `${name}-node`,
    {
      metadata: {
        annotations: { "pulumi.com/patchForce": "true" },
        labels: { [exit.nodeLabel]: "true" },
        name: exit.node,
      },
    },
    { provider },
  );

  const password = new random.RandomPassword(`${name}-ss`, {
    length: 32,
    special: false,
  });

  const config = password.result.apply((pw) =>
    JSON.stringify({
      server: "0.0.0.0",
      server_port: exit.port,
      method: exit.method,
      password: pw,
      // TCP + UDP on one port, so ss carries UDP
      // associations traverse the exit — QUIC/HTTP3 egress at the exit, not direct.
      mode: "tcp_and_udp",
    }),
  );
  const configHash = sha256hex(config);

  // Secret, not ConfigMap: config.json embeds the ss password in cleartext.
  const secret = new k8s.core.v1.Secret(
    `${name}-config`,
    {
      metadata: { name, namespace },
      stringData: { "config.json": config },
    },
    { provider },
  );

  new k8s.apps.v1.DaemonSet(
    name,
    {
      metadata: { name, namespace },
      spec: {
        selector: { matchLabels: { app: name } },
        updateStrategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
        },
        template: {
          // Roll the pod when the ss config (password/method/port) changes.
          metadata: {
            annotations: { "jaritanet/config-hash": configHash },
            labels: { app: name },
          },
          spec: {
            hostNetwork: true,
            // The node's resolver, not the cluster's: ss-rust resolves the
            // destination names its clients send it, and those should be
            // answered where the traffic egresses, not in Germany.
            //
            // This only resolves anything *because* of hostNetwork above, and
            // the two cannot be separated. A seeded agent sets no
            // `--resolv-conf`, so `Default` hands the pod the host's
            // /etc/resolv.conf — `nameserver 127.0.0.53`, the systemd-resolved
            // stub — which answers only where that address is a real listener,
            // i.e. the host's namespace. Drop hostNetwork and it becomes the
            // pod's own loopback with nothing behind it, which is the SERVFAIL
            // trap k3s.ts already documents for coredns.
            dnsPolicy: "Default",
            automountServiceAccountToken: false,
            nodeSelector: { [exit.nodeLabel]: "true" },
            containers: [
              {
                name: "ssserver",
                image: exit.image,
                command: ["ssserver", "-c", "/etc/shadowsocks/config.json"],
                volumeMounts: [
                  {
                    name: "config",
                    mountPath: "/etc/shadowsocks",
                    readOnly: true,
                  },
                ],
                resources: {
                  limits: LIMITS,
                  ...cpuRequests(LIMITS.cpu),
                },
              },
            ],
            volumes: [{ name: "config", secret: { secretName: name } }],
          },
        },
      },
    },
    // On the label as well as the config: Pulumi awaits DaemonSet readiness, and
    // a DaemonSet whose selector matches no node is "ready" with zero pods. Get
    // that order wrong and the first deploy reports success having scheduled
    // nothing, with the label landing a moment later.
    { dependsOn: [label, secret], provider },
  );

  return {
    method: exit.method,
    name: exit.name,
    password: password.result,
    port: exit.port,
    server: exit.server,
  };
}
