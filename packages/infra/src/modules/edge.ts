import * as command from "@pulumi/command";
import * as hcloud from "@pulumi/hcloud";
import type * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { EdgeConfSchema } from "../conf.schemas.ts";
import { XrayConfSchema } from "../conf.schemas.ts";
import { createHysteria } from "./hysteria.ts";
import { createTailscale } from "./tailscale.ts";
import { createXray } from "./xray.ts";

/**
 * Provisions a standalone VPN edge box: a Hetzner VPS running hy2 + REALITY +
 * a tailnet relay, and nothing else — no rathole, no reverse proxy, no TLS
 * services of its own.
 *
 * Because it fronts no home site, REALITY points its decoy at a real external
 * host (`edge.reality`) rather than a local backend — the "universal decoy"
 * the primary gateway can't use without breaking public access to its own
 * domain. Firewall is just 22 + 443 (tcp for REALITY, udp for hy2).
 *
 * Everything is keyed off `edge.name`: per-instance Pulumi resource names, the
 * `jaritanet-<name>` tailnet hostname, and (in main) the `<name>.<zone>` A
 * record clients dial. Returns the box IP and the transport handles the client
 * profile is built from.
 */
export function createEdge(
  edge: z.infer<typeof EdgeConfSchema>,
  authKey: pulumi.Output<string> | undefined,
) {
  const { name } = edge;

  const sshKey = new tls.PrivateKey(`${name}-ssh-key`, {
    algorithm: "ED25519",
  });

  const hcloudSshKey = new hcloud.SshKey(name, {
    publicKey: sshKey.publicKeyOpenssh,
  });

  const firewall = new hcloud.Firewall(name, {
    rules: [
      {
        description: "SSH",
        direction: "in",
        port: "22",
        protocol: "tcp",
        sourceIps: ["0.0.0.0/0", "::/0"],
      },
      {
        description: "HTTPS / REALITY",
        direction: "in",
        port: "443",
        protocol: "tcp",
        sourceIps: ["0.0.0.0/0", "::/0"],
      },
      {
        description: "Hysteria2 QUIC",
        direction: "in",
        port: String(edge.hysteria.port),
        protocol: "udp",
        sourceIps: ["0.0.0.0/0", "::/0"],
      },
    ],
  });

  const server = new hcloud.Server(name, {
    firewallIds: [firewall.id.apply((id) => Number(id))],
    image: edge.image,
    location: edge.location,
    serverType: edge.serverType,
    sshKeys: [hcloudSshKey.id.apply((id) => id.toString())],
  });

  const connection = {
    host: server.ipv4Address,
    privateKey: sshKey.privateKeyOpenssh,
    user: "root",
  };

  // BBR + fq: cubic collapses on packet loss; BBR holds the pipe open, which
  // is what the hy2/reality traffic rides over. Same tuning as the gateway.
  new command.remote.Command(
    `${name}-network-tuning`,
    {
      connection,
      create: `cat > /etc/sysctl.d/99-network-tuning.conf << 'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
sysctl --system`,
      triggers: ["bbr-fq-v1"],
    },
    { dependsOn: [server] },
  );

  const hysteria = createHysteria(connection, server, edge.hysteria, name);

  // REALITY with an external decoy — parse through XrayConfSchema so the pinned
  // xray version default applies.
  const xray = createXray(
    connection,
    server,
    XrayConfSchema.parse({
      dest: edge.reality.dest,
      serverName: edge.reality.serverName,
    }),
    name,
  );

  // Joins the tailnet as jaritanet-<name> so this box can relay 100.x into the
  // mesh, exactly like the primary. Only when an auth key is present.
  const tailscale = authKey
    ? createTailscale(
        connection,
        server,
        { hostname: `jaritanet-${name}`, tag: "tag:server" },
        authKey,
        name,
      )
    : undefined;

  return { hysteria, name, server, tailscale, vpsIp: server.ipv4Address, xray };
}
