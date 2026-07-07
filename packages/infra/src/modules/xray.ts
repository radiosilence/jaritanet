import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { XrayConfSchema } from "../conf.schemas.ts";

type Connection = {
  host: pulumi.Output<string>;
  privateKey: pulumi.Output<string>;
  user: string;
};

/**
 * Provisions Xray-core with VLESS-Vision-REALITY on the gateway VPS.
 *
 * Xray owns :443 and impersonates a real TLS site. Unauthenticated
 * connections (active probes, browsers) are relayed byte-for-byte to
 * `dest` — the local rathole https port that tunnels to in-cluster
 * Traefik — so an observer sees the genuine site and its real cert.
 * Authenticated VLESS clients are proxied straight out to the internet,
 * giving a censorship-resistant VPN over what looks like plain HTTPS.
 *
 * Keys are minted on first boot and never leave the box: the x25519
 * private key stays in /etc/xray, and the UUID + shortId are Pulumi
 * secrets. A ready-to-paste vless:// share URL is returned for clients.
 */
export function createXray(
  connection: Connection,
  server: hcloud.Server,
  xray: z.infer<typeof XrayConfSchema>,
) {
  const uuid = new random.RandomUuid("xray-uuid");
  const shortId = new random.RandomId("xray-short-id", { byteLength: 8 });

  const install = new command.remote.Command(
    "xray-install",
    {
      connection,
      create: pulumi.interpolate`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
XRAY_VERSION=$(printf '%s' "${xray.version}" | sed 's/^v//')

# Official XTLS installer: sets up the systemd unit, a dedicated user,
# CAP_NET_BIND_SERVICE for :443, plus geodata and log dirs.
bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install --version "$XRAY_VERSION"

# Mint the REALITY keypair once; the private key never leaves the box.
if [ ! -f /usr/local/etc/xray/private.key ]; then
  /usr/local/bin/xray x25519 > /tmp/xray-keypair.txt
  sed -n '1p' /tmp/xray-keypair.txt | awk '{print $NF}' > /usr/local/etc/xray/private.key
  sed -n '2p' /tmp/xray-keypair.txt | awk '{print $NF}' > /usr/local/etc/xray/public.key
  rm -f /tmp/xray-keypair.txt
fi`,
      triggers: [xray.version],
    },
    { dependsOn: [server] },
  );

  // Read back the minted public key so clients can be configured.
  const publicKey = new command.remote.Command(
    "xray-public-key",
    {
      connection,
      create: "cat /usr/local/etc/xray/public.key",
      triggers: [install.id],
    },
    { dependsOn: [install] },
  );

  // Render config.json on the box, injecting the private key from disk so
  // it stays off the wire and out of Pulumi state.
  const config = new command.remote.Command(
    "xray-config",
    {
      connection,
      create: pulumi.interpolate`set -euo pipefail
PRIV=$(cat /usr/local/etc/xray/private.key)
cat > /usr/local/etc/xray/config.json << XRAY_EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "listen": "0.0.0.0",
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [{ "id": "${uuid.result}", "flow": "xtls-rprx-vision" }],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "${xray.dest}",
          "xver": 0,
          "serverNames": ["${xray.serverName}"],
          "privateKey": "$PRIV",
          "shortIds": ["${shortId.hex}"]
        }
      }
    }
  ],
  "outbounds": [{ "protocol": "freedom" }]
}
XRAY_EOF
systemctl restart xray`,
      triggers: [
        uuid.result,
        shortId.hex,
        xray.serverName,
        xray.dest,
        publicKey.stdout,
      ],
    },
    { dependsOn: [publicKey] },
  );

  // vless:// URL that Shadowrocket / sing-box / v2box import directly.
  const shareUrl = pulumi.interpolate`vless://${uuid.result}@${connection.host}:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${xray.serverName}&fp=chrome&pbk=${publicKey.stdout}&sid=${shortId.hex}&type=tcp#jaritanet`;

  return {
    config,
    publicKey: publicKey.stdout,
    shareUrl: pulumi.secret(shareUrl),
    shortId: shortId.hex,
    uuid: uuid.result,
  };
}
