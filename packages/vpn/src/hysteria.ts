import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { HysteriaConfSchema } from "./hysteria.schemas.ts";
import type { VpnUser } from "./users.ts";
import { sha256hex } from "@jaritanet/k8s";
import { UNTRACKED, VERSIONS } from "./versions.ts";

/**
 * Hysteria2 (QUIC/UDP), in the cluster on the node it fronts.
 *
 * Same transport as the systemd units in hysteria-systemd.ts, with the same
 * split: admin-only `userpass` auth (a guest has no hy2 credential at all,
 * which is what makes the guest tailnet block in xray enforceable) and a
 * server-wide Salamander obfs password. What changes is where the secrets come
 * from — Pulumi mints the passwords and the self-signed cert, rather than
 * openssl on the box, so nothing has to be read back over SSH.
 *
 * One container per port rather than one pod per port. Hysteria takes a single
 * `listen`, so each port needs its own process; sharing a pod means one
 * `hostNetwork` namespace, one config Secret and one restart when credentials
 * rotate. Why several ports at all is in HysteriaConfSchema: no single UDP port
 * survives every network, so the client urltests all of them.
 *
 * The cert is self-signed and pinned: every profile carries it as the only
 * certificate its hy2 outbounds accept, so no public CA can vouch for an
 * impostor and the obfs password, which every admin holds, is not enough to sit
 * in the middle and collect the others' passwords.
 *
 * On offload and crypto: QUIC's fast paths here are UDP GSO/GRO (`UDP_SEGMENT`
 * / `UDP_GRO` via setsockopt) and `sendmmsg`/`recvmmsg`, all of which the
 * default seccomp profile permits — v2.10.0 starts and serves clean under
 * `RuntimeDefault` with host networking, checked against the image itself.
 * AES-NI and AVX2 are CPU instructions chosen by Go at runtime, so seccomp,
 * which filters syscalls, cannot affect them either.
 *
 * The one thing a container genuinely cannot fix for itself is the UDP receive
 * buffer: quic-go asks for several megabytes and the kernel silently caps it at
 * `net.core.rmem_max`, which Ubuntu ships at 208KB. It surfaces as quic-go's
 * "failed to sufficiently increase receive buffer size" on the connection path,
 * not at start-up, so a healthy-looking daemon can already be dropping
 * datagrams. `hostNetwork` means the node's value is the one in force — see
 * createNetworkTuning, which raises it to hysteria's documented 16MB.
 *
 * The hysteria containers run as nobody with no capabilities. A privileged port
 * is served from `listenPort(port)` instead, because a hostNetwork pod cannot
 * lower `ip_unprivileged_port_start` for itself and Kubernetes grants
 * NET_BIND_SERVICE to uid 0 alone. Clients still dial the real port: the pod's
 * `redirect` sidecar holds an nftables table on the node that redirects it
 * (see redirectScript). The rule therefore exists exactly while this pod does,
 * on whichever node runs it, and goes when the pod goes. The sidecar is the one
 * root process left, holding NET_ADMIN and nothing else, and it parses no
 * client traffic.
 */
export function createHysteria(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  hysteria: z.infer<typeof HysteriaConfSchema>,
  users: VpnUser[],
  entryLabel: string,
  // Changing this reissues every credential here; see credentialRotation.
  rotation: string,
  dependsOn: pulumi.Resource[] = [],
) {
  const keepers = { rotation };

  const admins = users.filter((u) => u.role === "admin");
  const passwords: Record<string, pulumi.Output<string>> = {};
  for (const a of admins) {
    passwords[a.name] = new random.RandomPassword(`hysteria-auth-${a.name}`, {
      keepers,
      length: 32,
      special: false,
    }).result;
  }

  const obfsPassword = new random.RandomPassword("hysteria-obfs", {
    keepers,
    length: 32,
    special: false,
  }).result;

  const key = new tls.PrivateKey("hysteria-key", {
    algorithm: "ECDSA",
    ecdsaCurve: "P256",
  });
  const cert = new tls.SelfSignedCert("hysteria-cert", {
    privateKeyPem: key.privateKeyPem,
    allowedUses: ["digital_signature", "key_encipherment", "server_auth"],
    dnsNames: [hysteria.sni],
    subject: { commonName: hysteria.sni },
    validityPeriodHours: 24 * 365 * 10,
  });

  const ports = [hysteria.port, ...hysteria.altPorts];
  // Two ports on one listener would leave one container crash-looping on
  // EADDRINUSE while the DaemonSet reports itself rolled out.
  if (new Set(ports.map(listenPort)).size !== ports.length) {
    throw new Error(
      `hysteria ports ${ports.join(", ")} collide once privileged ones move up 10000`,
    );
  }
  const redirects = ports
    .filter((port) => listenPort(port) !== port)
    .map((port) => ({ port, to: listenPort(port) }));

  // YAML userpass block: "    <name>: <password>" per admin, resolved together.
  const userpassBlock = pulumi
    .all(admins.map((a) => passwords[a.name]))
    .apply((pws) =>
      admins.map((a, i) => `    ${a.name}: ${pws[i]}`).join("\n"),
    );

  const configs = Object.fromEntries(
    ports.map((port) => [
      `config-${port}.yaml`,
      pulumi.interpolate`listen: :${listenPort(port)}
tls:
  cert: /etc/hysteria/cert.pem
  key: /etc/hysteria/key.pem
obfs:
  type: salamander
  salamander:
    password: ${obfsPassword}
auth:
  type: userpass
  userpass:
${userpassBlock}
`,
    ]),
  );

  const secret = new k8s.core.v1.Secret(
    "hysteria-config",
    {
      metadata: { name: "hysteria", namespace },
      stringData: {
        ...configs,
        "cert.pem": cert.certPem,
        "key.pem": key.privateKeyPem,
      },
    },
    { provider },
  );

  const app = "hysteria";
  new k8s.apps.v1.DaemonSet(
    app,
    {
      metadata: { name: app, namespace },
      spec: {
        selector: { matchLabels: { app } },
        // The DaemonSet default, spelled out because it is load-bearing: host
        // UDP ports are exclusive, so the old pod must be deleted before the
        // replacement is created (maxSurge 0) or the new one never binds.
        updateStrategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
        },
        template: {
          metadata: {
            labels: { app },
            // Hysteria reads its config and cert once at exec, so a rotated
            // password or a reissued cert in the Secret would otherwise never
            // reach the running process — and a pinned cert the server is not
            // serving fails every client.
            annotations: {
              "jaritanet/config": sha256hex(
                pulumi
                  .all([...Object.values(configs), cert.certPem])
                  .apply((c) => c.join()),
              ).apply((h) => h.slice(0, 16)),
            },
          },
          spec: {
            // Real client source addresses, and the host's own UDP ports.
            hostNetwork: true,
            // The host's resolver is unbound on this same box, not the cluster.
            dnsPolicy: "Default",
            automountServiceAccountToken: false,
            // Entries are chosen per node, not per cluster: `lady` is a node
            // and must not answer :443 by virtue of being one.
            nodeSelector: { [entryLabel]: "true" },
            // apk needs root to initialise a package database, so this installs
            // nftables and conntrack into a volume with no capabilities at all,
            // and the sidecar below runs them from there on a read-only root.
            ...(redirects.length > 0 && {
              initContainers: [
                {
                  name: "redirect-deps",
                  image: UNTRACKED.alpine,
                  command: [
                    "apk",
                    "add",
                    "--no-cache",
                    "--no-scripts",
                    "--root",
                    "/deps",
                    "--initdb",
                    "--keys-dir",
                    "/etc/apk/keys",
                    "--repositories-file",
                    "/etc/apk/repositories",
                    "nftables",
                    "conntrack-tools",
                  ],
                  securityContext: {
                    runAsUser: 0,
                    runAsNonRoot: false,
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    seccompProfile: { type: "RuntimeDefault" },
                    capabilities: { drop: ["ALL"] },
                  },
                  volumeMounts: [{ name: "deps", mountPath: "/deps" }],
                  // Unpacking a package needs well over what the sidecar uses.
                  resources: {
                    requests: { cpu: "5m", memory: "16Mi" },
                    limits: { memory: "128Mi" },
                  },
                },
              ],
            }),
            containers: [
              ...ports.map((port) => ({
                name: `${app}-${port}`,
                image: VERSIONS.hysteria,
                args: ["server", "-c", `/etc/hysteria/config-${port}.yaml`],
                // A CPU request and no CPU limit: a limit means CFS throttling,
                // which on a QUIC transport is periodic latency spikes and
                // stalled transfers, not a graceful slowdown. The request is a
                // floor under contention, and with no limit each container still
                // bursts into whatever the box has spare.
                //
                // The floor differs by port on purpose. Exactly one of these
                // carries a given client's traffic — whichever its network lets
                // through — so :443 gets the daily-driver share and the
                // alternates, idle unless 443 is blocked, get enough to be
                // schedulable. Being idle is not the same as being unimportant:
                // when 3478 is the port that works it bursts freely, it just does
                // not reserve capacity for the case that never comes.
                //
                // Memory is requested at the measured working set and limited
                // at 1Gi: QUIC buffers scale with concurrent streams, and rathole
                // was OOMKilled at 64Mi doing strictly less.
                resources:
                  port < 1024
                    ? // The primary port carries the daily-driver traffic; the
                      // alt ports exist so a blocked 443 has somewhere to fall
                      // back to and normally carry nothing. QUIC buffers scale
                      // with concurrent streams, hence the memory. No CPU limit,
                      // for the reason in xray.ts.
                      {
                        requests: { cpu: "750m", memory: "32Mi" },
                        limits: { memory: "1Gi" },
                      }
                    : {
                        requests: { cpu: "100m", memory: "32Mi" },
                        limits: { memory: "1Gi" },
                      },
                volumeMounts: [
                  {
                    name: "config",
                    mountPath: "/etc/hysteria",
                    readOnly: true,
                  },
                ],
                // Every port binds unprivileged; see listenPort.
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: 65534,
                  runAsGroup: 65534,
                  allowPrivilegeEscalation: false,
                  seccompProfile: { type: "RuntimeDefault" },
                  capabilities: { drop: ["ALL"] },
                },
              })),
              ...(redirects.length > 0
                ? [
                    {
                      name: "redirect",
                      image: UNTRACKED.alpine,
                      command: ["sh", "-c", redirectScript(redirects)],
                      volumeMounts: [
                        { name: "deps", mountPath: "/deps", readOnly: true },
                      ],
                      // Root with NET_ADMIN alone: loading a nat table and
                      // deleting conntrack entries need both, and nothing else.
                      securityContext: {
                        runAsUser: 0,
                        runAsNonRoot: false,
                        allowPrivilegeEscalation: false,
                        readOnlyRootFilesystem: true,
                        seccompProfile: { type: "RuntimeDefault" },
                        capabilities: { drop: ["ALL"], add: ["NET_ADMIN"] },
                      },
                      resources: {
                        requests: { cpu: "5m", memory: "8Mi" },
                        limits: { memory: "32Mi" },
                      },
                    },
                  ]
                : []),
            ],
            volumes: [
              { name: "config", secret: { secretName: secret.metadata.name } },
              ...(redirects.length > 0 ? [{ name: "deps", emptyDir: {} }] : []),
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );

  return { certificate: cert.certPem, obfsPassword, passwords };
}

/**
 * Where a container serves a client-facing port: the port itself when it is
 * unprivileged, else 10000 above it (443 is served on 10443), which the
 * `redirect` sidecar points the real port at.
 */
export const listenPort = (port: number) => (port < 1024 ? port + 10000 : port);

/**
 * The `redirect` sidecar: loads an nftables table on the node that redirects
 * each privileged port to its listener, re-asserts it every minute, and on
 * SIGTERM deletes it, so the rule lives exactly as long as the pod.
 *
 * A table of its own, at nat `dstnat` priority in `prerouting`: it never
 * touches Cilium's or Tailscale's rules, and it sees only traffic arriving at
 * the node, which is all a client is. `redirect` rewrites only the destination
 * port, so hysteria still sees the client's address, and conntrack un-NATs the
 * replies. Conntrack entries for the port are flushed on apply and on removal:
 * a flow tracked before the rule changed keeps its old translation and would
 * otherwise go on reaching a port nothing listens on.
 */
export function redirectScript(redirects: { port: number; to: number }[]) {
  const rules = redirects
    .map((r) => `    udp dport ${r.port} redirect to :${r.to}`)
    .join("\n");
  const flushes = redirects
    .map(
      (r) =>
        `  LD_LIBRARY_PATH=/deps/usr/lib /deps/usr/sbin/conntrack -D -p udp --orig-port-dst ${r.port} >/dev/null 2>&1 || true`,
    )
    .join("\n");
  return `set -eu
nft() { LD_LIBRARY_PATH=/deps/usr/lib /deps/usr/sbin/nft "$@"; }
flush() {
${flushes}
}
apply() {
  nft -f - <<'NFT'
table inet jaritanet_hysteria
delete table inet jaritanet_hysteria
table inet jaritanet_hysteria {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
${rules}
  }
}
NFT
  flush
}
cleanup() {
  nft delete table inet jaritanet_hysteria 2>/dev/null || true
  flush
  echo "removed the redirect"
  exit 0
}
trap cleanup TERM INT
apply
echo "redirecting ${redirects.map((r) => `UDP ${r.port} to ${r.to}`).join(", ")}"
while :; do
  sleep 60 & wait $!
  nft list table inet jaritanet_hysteria >/dev/null 2>&1 || { apply; echo "re-applied the redirect"; }
done
`;
}
