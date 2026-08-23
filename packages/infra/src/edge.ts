import {
  createAdminSshAccess,
  createAutomaticPatching,
  createNetworkTuning,
  inboundRule,
} from "@jaritanet/hetzner";
import {
  createHysteriaSystemd,
  createTailscaleSystemd,
  createXraySystemd,
  type VpnUser,
  XrayConfSchema,
} from "@jaritanet/vpn";
import * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { EdgeConfSchema } from "./schemas.ts";

/**
 * The tag every edge advertises. Exported because the policy defines the tags
 * the fleet advertises, and a tag it fails to define is one an edge cannot
 * join with.
 */
export const EDGE_TAILNET_TAG = "tag:server";

/**
 * Provisions a standalone VPN edge box: a Hetzner VPS running hy2 + REALITY +
 * a tailnet relay, and nothing else — no reverse proxy, no TLS
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
  users: VpnUser[],
  authKey: pulumi.Output<string> | undefined,
  adminSshKey: string | undefined,
  proToken: string | undefined,
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
      inboundRule("SSH", 22),
      inboundRule("HTTPS / REALITY", 443),
      inboundRule("Hysteria2 QUIC", edge.hysteria.port, "udp"),
      ...edge.hysteria.altPorts.map((port) =>
        inboundRule(`Hysteria2 QUIC (alt ${port})`, port, "udp"),
      ),
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

  createNetworkTuning(name, connection, server);

  createAutomaticPatching(
    name,
    connection,
    server,
    proToken ? pulumi.secret(proToken) : undefined,
  );

  if (adminSshKey) {
    createAdminSshAccess(name, connection, server, adminSshKey);
  }

  const opts = { name, dependsOn: [server] };

  const hysteria = createHysteriaSystemd(
    connection,
    edge.hysteria,
    users,
    opts,
  );

  // REALITY with an external decoy — parse through XrayConfSchema so the pinned
  // xray version default applies.
  const xray = createXraySystemd(
    connection,
    XrayConfSchema.parse({
      dest: edge.reality.dest,
      // One name, not a list: an edge's dest IS the site it mimics, so a second
      // SNI would be one dest cannot serve a real cert for.
      serverNames: [edge.reality.serverName],
    }),
    users,
    opts,
  );

  // Joins the tailnet as jaritanet-<name> so this box can relay 100.x into the
  // mesh, exactly like the primary. Only when an auth key is present.
  const tailscale = authKey
    ? createTailscaleSystemd(
        connection,
        { hostname: `jaritanet-${name}`, tag: EDGE_TAILNET_TAG },
        authKey,
        opts,
      )
    : undefined;

  return { hysteria, name, server, tailscale, vpsIp: server.ipv4Address, xray };
}
