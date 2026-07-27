import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { HysteriaConfSchema } from "../conf.schemas.ts";
import type { VpnUser } from "../env.schema.ts";
import { sha256hex } from "../util.ts";

// Hysteria2 has no releases on ghcr; tobyxdd/hysteria is the image its own docs
// point at, published by the maintainer from the apernet/hysteria repo.
const IMAGE = "docker.io/tobyxdd/hysteria:v2.10.0";

/**
 * Hysteria2 (QUIC/UDP) as pods on the gateway's own cluster.
 *
 * Same transport as the SSH-provisioned units in hysteria.ts, with the same
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
 */
export function createHysteriaPod(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  hysteria: z.infer<typeof HysteriaConfSchema>,
  users: VpnUser[],
  dependsOn: pulumi.Resource[] = [],
) {
  const admins = users.filter((u) => u.role === "admin");
  const passwords: Record<string, pulumi.Output<string>> = {};
  for (const a of admins) {
    passwords[a.name] = new random.RandomPassword(
      `hysteria-pod-auth-${a.name}`,
      {
        length: 32,
        special: false,
      },
    ).result;
  }

  const obfsPassword = new random.RandomPassword("hysteria-pod-obfs", {
    length: 32,
    special: false,
  }).result;

  const key = new tls.PrivateKey("hysteria-pod-key", {
    algorithm: "ECDSA",
    ecdsaCurve: "P256",
  });
  const cert = new tls.SelfSignedCert("hysteria-pod-cert", {
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
  new k8s.apps.v1.Deployment(
    app,
    {
      metadata: { name: app, namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app } },
        // Host UDP ports are exclusive, so the old pod has to go before the new
        // one starts — a rolling update would deadlock on the bind.
        strategy: { type: "Recreate" },
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
            containers: ports.map((port) => ({
              name: `${app}-${port}`,
              image: IMAGE,
              args: ["server", "-c", `/etc/hysteria/config-${port}.yaml`],
              // No CPU limit: this is the daily-driver transport, and
              // throttling it presents as a slow VPN, not as a resource problem.
              resources: { limits: { memory: "128Mi" } },
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
