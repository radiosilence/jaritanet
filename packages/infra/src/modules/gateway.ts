import * as command from "@pulumi/command";
import * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { GatewayConfSchema } from "../conf.schemas.ts";

/**
 * Provisions a Hetzner VPS running rathole as a TCP relay.
 * The VPS is completely stateless — no certs, no proxy config.
 * It just tunnels ports 80/443 from the public internet to
 * the rathole client running inside the K8s cluster.
 */
export function createGateway(gateway: z.infer<typeof GatewayConfSchema>) {
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

  // Write rathole config via SSH (supports updates without replacing the server)
  const ratholeConfig = pulumi.interpolate`[server]
bind_addr = "0.0.0.0:2333"
default_token = "${ratholeToken.result}"

[server.services.https]
type = "tcp"
bind_addr = "0.0.0.0:443"

[server.services.http]
type = "tcp"
bind_addr = "0.0.0.0:80"
`;

  const configUpload = new command.remote.Command(
    "rathole-config",
    {
      connection,
      create: pulumi.interpolate`cat > /etc/rathole/server.toml << 'RATHOLE_EOF'
${ratholeConfig}
RATHOLE_EOF`,
      triggers: [ratholeToken.result],
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

  return {
    ratholeToken,
    server,
    sshKey,
    vpsIp: server.ipv4Address,
  };
}
