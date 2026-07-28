import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { HysteriaConfSchema } from "../conf.schemas.ts";
import type { VpnUser } from "../env.schema.ts";
import { sha256hex, VPN_ENTRY_LABEL } from "../util.ts";

// Hysteria2 publishes no images under the apernet org — `ghcr.io/apernet/
// hysteria` does not exist. tobyxdd is the maintainer, and this is the image
// hysteria's own installation docs and docker-compose example point at.
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
 * The cert is cosmetic — clients trust it via `insecure` with a pinned SNI —
 * but it has to exist, so Pulumi generates it for the same reason it generates
 * everything else here.
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
 */
export function createHysteria(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  hysteria: z.infer<typeof HysteriaConfSchema>,
  users: VpnUser[],
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

  // YAML userpass block: "    <name>: <password>" per admin, resolved together.
  const userpassBlock = pulumi
    .all(admins.map((a) => passwords[a.name]))
    .apply((pws) =>
      admins.map((a, i) => `    ${a.name}: ${pws[i]}`).join("\n"),
    );

  const configs = Object.fromEntries(
    ports.map((port) => [
      `config-${port}.yaml`,
      pulumi.interpolate`listen: :${port}
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
            // Hysteria reads its config once at exec, so a rotated password in
            // the Secret would otherwise never reach the running process.
            annotations: {
              "jaritanet/config": sha256hex(
                pulumi.all(Object.values(configs)).apply((c) => c.join()),
              ).apply((h) => h.slice(0, 16)),
            },
          },
          spec: {
            // Real client source addresses, and the host's own UDP ports.
            hostNetwork: true,
            // The host's resolver is unbound on this same box, not the cluster.
            dnsPolicy: "Default",
            automountServiceAccountToken: false,
            // Entries are chosen per node, not per cluster: `lady` joins soon
            // and must not start answering :443 by virtue of being a node.
            nodeSelector: { [VPN_ENTRY_LABEL]: "true" },
            containers: ports.map((port) => ({
              name: `${app}-${port}`,
              image: hysteria.image,
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
              // 256Mi/128Mi: rathole was OOMKilled at 64Mi doing strictly less
              // (no crypto, no congestion control, no per-connection QUIC
              // state), so these are floors rather than generous ceilings.
              resources:
                port < 1024
                  ? // The primary port carries the daily-driver traffic; the
                    // alt ports exist so a blocked 443 has somewhere to fall
                    // back to and normally carry nothing. QUIC buffers scale
                    // with concurrent streams, hence the memory. No CPU limit,
                    // for the reason in xray.ts.
                    { requests: { cpu: "750m" }, limits: { memory: "768Mi" } }
                  : { requests: { cpu: "100m" }, limits: { memory: "256Mi" } },
              volumeMounts: [
                { name: "config", mountPath: "/etc/hysteria", readOnly: true },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                seccompProfile: { type: "RuntimeDefault" },
                capabilities: {
                  drop: ["ALL"],
                  // Only the privileged port needs it; the alternates (3478,
                  // 4500) are above 1024 and bind with no capability at all.
                  ...(port < 1024 ? { add: ["NET_BIND_SERVICE"] } : {}),
                },
              },
            })),
            volumes: [
              { name: "config", secret: { secretName: secret.metadata.name } },
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );

  return { obfsPassword, passwords };
}
