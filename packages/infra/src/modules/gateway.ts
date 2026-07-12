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
 * Provisions a Hetzner VPS running frp (fatedier/frp) as the relay server.
 *
 * frps is deliberately dumb — just a bind port + auth token. Every proxy (home
 * Traefik, the exit loopbacks) is declared by the *clients* (frpc), so the
 * server needs no per-service config and a new exit needs no gateway change.
 * frp carries UDP as well as TCP, so exits are no longer TCP-only.
 *
 * frps is installed over SSH (not cloud-init) so it can land on the *existing*
 * box; `userData` is ignored to keep a config change from replacing the VPS
 * (which would lose the on-box REALITY keys and rotate the IP).
 */
export function createGateway(gateway: z.infer<typeof GatewayConfSchema>) {
  const frpToken = new random.RandomPassword("frp-token", { length: 64 });

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
        description: "frp control channel",
        direction: "in",
        port: "7000",
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

  // Base image only — frp is installed over SSH below, so a change here never
  // needs to rebuild the box (see ignoreChanges).
  const serverConfig = `#!/bin/bash
set -euo pipefail
apt-get update -y || true
`;

  const server = new hcloud.Server(
    "gateway",
    {
      firewallIds: [firewall.id.apply((id) => Number(id))],
      image: gateway.image,
      location: gateway.location,
      serverType: gateway.serverType,
      sshKeys: [hcloudSshKey.id.apply((id) => id.toString())],
      userData: serverConfig,
    },
    // userData only runs at first boot; keep changes to it from replacing the
    // live VPS (which holds the on-box REALITY private key).
    { ignoreChanges: ["userData"] },
  );

  const connection = {
    host: server.ipv4Address,
    privateKey: sshKey.privateKeyOpenssh,
    user: "root",
  };

  // Enable BBR congestion control + fq qdisc. Default (cubic) collapses
  // throughput on packet loss; BBR holds the pipe open across lossy links.
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

  // Install frps over SSH (idempotent) so it lands on the existing box, and
  // retire the old rathole unit. Keyed on the version.
  const frpVer = gateway.frpVersion.replace(/^v/, "");
  const install = new command.remote.Command(
    "frp-install",
    {
      connection,
      create: pulumi.interpolate`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
FRP_VER="${frpVer}"
if ! /usr/local/bin/frps --version 2>/dev/null | grep -q "$FRP_VER"; then
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v$FRP_VER/frp_${"$"}{FRP_VER}_linux_amd64.tar.gz" -o /tmp/frp.tgz
  tar -xzf /tmp/frp.tgz -C /tmp
  install -m 0755 "/tmp/frp_${"$"}{FRP_VER}_linux_amd64/frps" /usr/local/bin/frps
  rm -rf /tmp/frp.tgz "/tmp/frp_${"$"}{FRP_VER}_linux_amd64"
fi
mkdir -p /etc/frp
cat > /etc/systemd/system/frps.service << 'UNIT'
[Unit]
Description=frp server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable frps
# retire rathole (migrated to frp)
systemctl disable --now rathole 2>/dev/null || true`,
      triggers: [frpVer],
    },
    { dependsOn: [server] },
  );

  // frps config: just bind port + token. All proxies are client-declared.
  const configUpload = new command.remote.Command(
    "frp-config",
    {
      connection,
      create: pulumi.interpolate`cat > /etc/frp/frps.toml << 'FRP_EOF'
bindPort = 7000
auth.method = "token"
auth.token = "${frpToken.result}"
FRP_EOF
systemctl restart frps`,
      triggers: [frpToken.result],
    },
    { dependsOn: [install] },
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
    configUpload,
    frpToken,
    hysteria,
    server,
    sshKey,
    tailscale,
    vpsIp: server.ipv4Address,
    xray,
  };
}
