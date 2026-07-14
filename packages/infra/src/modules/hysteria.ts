import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { HysteriaConfSchema } from "../conf.schemas.ts";
import { type Connection, resourcePrefix } from "./vps.ts";

/**
 * Provisions Hysteria2 (QUIC/UDP) on the gateway VPS.
 *
 * Unlike the TCP-based Reality path, Hysteria2 runs over QUIC with
 * loss-tolerant congestion control, so it stays smooth on lossy/jittery
 * links where TCP-over-TCP melts down. Salamander obfuscation scrambles
 * the QUIC so DPI can't fingerprint it. Auth + obfs passwords are Pulumi
 * secrets; the TLS cert is a self-signed keypair minted on the box that
 * clients trust via insecure + pinned SNI. Returns a share URL for clients.
 */
export function createHysteria(
  connection: Connection,
  server: hcloud.Server,
  hysteria: z.infer<typeof HysteriaConfSchema>,
  name = "",
) {
  const p = resourcePrefix(name);
  const authPassword = new random.RandomPassword(`${p}hysteria-auth`, {
    length: 32,
    special: false,
  });
  const obfsPassword = new random.RandomPassword(`${p}hysteria-obfs`, {
    length: 32,
    special: false,
  });

  const install = new command.remote.Command(
    `${p}hysteria-install`,
    {
      connection,
      create: pulumi.interpolate`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get install -y openssl
# Official installer: binary + hysteria-server.service systemd unit.
bash -c "$(curl -fsSL https://get.hy2.sh/)"
mkdir -p /etc/hysteria
# Self-signed cert once; clients trust it via insecure + pinned SNI.
if [ ! -f /etc/hysteria/cert.pem ]; then
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout /etc/hysteria/key.pem -out /etc/hysteria/cert.pem \
    -subj "/CN=${hysteria.sni}" -days 3650
  chown hysteria:hysteria /etc/hysteria/key.pem /etc/hysteria/cert.pem 2>/dev/null || true
fi`,
      triggers: ["hysteria-v1"],
    },
    { dependsOn: [server] },
  );

  const config = new command.remote.Command(
    `${p}hysteria-config`,
    {
      connection,
      create: pulumi.interpolate`set -euo pipefail
cat > /etc/hysteria/config.yaml << HY_EOF
listen: :${hysteria.port}
tls:
  cert: /etc/hysteria/cert.pem
  key: /etc/hysteria/key.pem
obfs:
  type: salamander
  salamander:
    password: ${obfsPassword.result}
auth:
  type: password
  password: ${authPassword.result}
HY_EOF
systemctl enable hysteria-server
systemctl restart hysteria-server`,
      triggers: [
        authPassword.result,
        obfsPassword.result,
        pulumi.interpolate`${hysteria.port}`,
      ],
    },
    { dependsOn: [install] },
  );

  // hysteria2:// share URL for client import.
  const shareUrl = pulumi.interpolate`hysteria2://${authPassword.result}@${connection.host}:${hysteria.port}/?obfs=salamander&obfs-password=${obfsPassword.result}&sni=${hysteria.sni}&insecure=1#jaritanet`;

  return {
    authPassword: authPassword.result,
    config,
    obfsPassword: obfsPassword.result,
    shareUrl: pulumi.secret(shareUrl),
  };
}
