import * as command from "@pulumi/command";
import * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { GatewayConfSchema } from "../conf.schemas.ts";
import { env } from "../env.ts";
import { createHysteria } from "./hysteria.ts";
import { createTailscale } from "./tailscale.ts";
import { createXray } from "./xray.ts";

/**
 * Provisions a Hetzner VPS running rathole as a TCP relay.
 * The VPS is completely stateless — no certs, no proxy config.
 * It just tunnels ports 80/443 from the public internet to
 * the rathole client running inside the K8s cluster.
 */
export function createGateway(
  gateway: z.infer<typeof GatewayConfSchema>,
  exits: { name: string; port: number }[] = [],
) {
  const ratholeToken = new random.RandomPassword("rathole-token", {
    length: 64,
  });

  const sshKey = new tls.PrivateKey("gateway-ssh-key", {
    algorithm: "ED25519",
  });

  const hcloudSshKey = new hcloud.SshKey("gateway", {
    publicKey: sshKey.publicKeyOpenssh,
  });

  const firewall = new hcloud.Firewall("gateway", {
    rules: [
      {
        description: "SSH",
        direction: "in",
        port: "22",
        protocol: "tcp",
        sourceIps: ["0.0.0.0/0", "::/0"],
      },
      {
        description: "HTTP",
        direction: "in",
        port: "80",
        protocol: "tcp",
        sourceIps: ["0.0.0.0/0", "::/0"],
      },
      {
        description: "HTTPS",
        direction: "in",
        port: "443",
        protocol: "tcp",
        sourceIps: ["0.0.0.0/0", "::/0"],
      },
      {
        description: "Rathole control channel",
        direction: "in",
        port: "2333",
        protocol: "tcp",
        sourceIps: ["0.0.0.0/0", "::/0"],
      },
      ...(gateway.hysteria
        ? [
            {
              description: "Hysteria2 QUIC",
              direction: "in",
              port: String(gateway.hysteria.port),
              protocol: "udp",
              sourceIps: ["0.0.0.0/0", "::/0"],
            },
          ]
        : []),
    ],
  });

  const serverConfig = pulumi.interpolate`#!/bin/bash
set -euo pipefail

# Install rathole
curl -fsSL "https://github.com/rapiz1/rathole/releases/download/${gateway.ratholeVersion}/rathole-x86_64-unknown-linux-gnu.zip" -o /tmp/rathole.zip
apt-get update && apt-get install -y unzip
unzip /tmp/rathole.zip -d /usr/local/bin/
chmod +x /usr/local/bin/rathole
rm /tmp/rathole.zip

# Write config (token will be updated via remote command)
mkdir -p /etc/rathole

# Systemd unit
cat > /etc/systemd/system/rathole.service << 'UNIT'
[Unit]
Description=Rathole Server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/rathole --server /etc/rathole/server.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable rathole
`;

  const server = new hcloud.Server("gateway", {
    firewallIds: [firewall.id.apply((id) => Number(id))],
    image: gateway.image,
    location: gateway.location,
    serverType: gateway.serverType,
    sshKeys: [hcloudSshKey.id.apply((id) => id.toString())],
    userData: serverConfig,
  });

  const connection = {
    host: server.ipv4Address,
    privateKey: sshKey.privateKeyOpenssh,
    user: "root",
  };

  // Enable BBR congestion control + fq qdisc. Default (cubic) collapses
  // throughput on packet loss; BBR holds the pipe open across lossy links,
  // which is what the relayed traffic rides over. Applied over SSH so the
  // server is never rebuilt.
  new command.remote.Command(
    "gateway-network-tuning",
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

  // Caching DNS forwarder on loopback. Clients dial 127.0.0.1:53 *at this box*
  // through the tunnel (a DNS server with detour=entry-select), so unbound has
  // zero public attack surface — reachable only from inside the tunnel. It
  // forwards upstream to Cloudflare over DoT (:853), so there is no cleartext
  // DNS anywhere in the chain: client→gateway is the encrypted tunnel, and
  // gateway→resolver is TLS. Prefetch + serve-expired keep the hot set warm, so
  // a client-cache miss is answered from this Germany-local cache in one tunnel
  // RTT instead of a round trip to the upstream from the client's location.
  new command.remote.Command(
    "gateway-unbound",
    {
      connection,
      create: `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get install -y unbound ca-certificates
cat > /etc/unbound/unbound.conf.d/jaritanet.conf << 'EOF'
server:
  interface: 127.0.0.1
  port: 53
  do-ip6: no
  access-control: 127.0.0.0/8 allow
  prefetch: yes
  prefetch-key: yes
  serve-expired: yes
  serve-expired-ttl: 86400
  cache-min-ttl: 120
  cache-max-ttl: 86400
  msg-cache-size: 64m
  rrset-cache-size: 128m
  num-threads: 2
  so-reuseport: yes
  qname-minimisation: yes
  hide-identity: yes
  hide-version: yes
  tls-cert-bundle: "/etc/ssl/certs/ca-certificates.crt"
forward-zone:
  name: "."
  forward-tls-upstream: yes
  forward-addr: 1.1.1.1@853#cloudflare-dns.com
  forward-addr: 1.0.0.1@853#cloudflare-dns.com
EOF
systemctl enable unbound
systemctl restart unbound`,
      triggers: ["unbound-v2"],
    },
    { dependsOn: [server] },
  );

  // When Xray is enabled it owns the public :443 and uses rathole as its
  // decoy backend, so rathole's https bind moves to a local-only port.
  const httpsBind = gateway.xray ? "127.0.0.1:8443" : "0.0.0.0:443";

  // Each exit's ss-rust port, surfaced on this gateway's loopback via rathole —
  // same pattern as the Reality decoy dest. The port is stable + identical
  // across gateways, so one client ss outbound reaches this exit via any entry.
  // A tcp *and* udp service on the same port so ss carries UDP (rathole muxes
  // udp datagrams over the control channel — no extra public port).
  const exitServices = exits
    .flatMap((e) =>
      ["tcp", "udp"].map(
        (proto) =>
          `\n[server.services.exit-${e.name}-${proto}]\ntype = "${proto}"\nbind_addr = "127.0.0.1:${e.port}"\n`,
      ),
    )
    .join("");

  // Write rathole config via SSH (supports updates without replacing the server)
  const ratholeConfig = pulumi.interpolate`[server]
bind_addr = "0.0.0.0:2333"
default_token = "${ratholeToken.result}"

[server.services.https]
type = "tcp"
bind_addr = "${httpsBind}"

[server.services.http]
type = "tcp"
bind_addr = "0.0.0.0:80"
${exitServices}`;

  const configUpload = new command.remote.Command(
    "rathole-config",
    {
      connection,
      create: pulumi.interpolate`cat > /etc/rathole/server.toml << 'RATHOLE_EOF'
${ratholeConfig}
RATHOLE_EOF`,
      triggers: [ratholeToken.result, httpsBind, exitServices],
    },
    { dependsOn: [server] },
  );

  new command.remote.Command(
    "rathole-restart",
    {
      connection,
      create: "systemctl restart rathole",
      triggers: [configUpload.id],
    },
    { dependsOn: [configUpload] },
  );

  const xray = gateway.xray
    ? createXray(connection, server, gateway.xray)
    : undefined;

  const hysteria = gateway.hysteria
    ? createHysteria(connection, server, gateway.hysteria)
    : undefined;

  // Tailnet relay: only when configured and an auth key is present, so
  // enabling `tailnet` in config before the secret is set is a safe no-op.
  const tailscale =
    gateway.tailnet && env.TS_AUTHKEY
      ? createTailscale(
          connection,
          server,
          gateway.tailnet,
          pulumi.secret(env.TS_AUTHKEY),
        )
      : undefined;

  return {
    hysteria,
    ratholeToken,
    server,
    sshKey,
    tailscale,
    vpsIp: server.ipv4Address,
    xray,
  };
}
