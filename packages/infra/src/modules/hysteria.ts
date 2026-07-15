import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { HysteriaConfSchema } from "../conf.schemas.ts";
import type { VpnUser } from "../env.schema.ts";

type Connection = {
  host: pulumi.Output<string>;
  privateKey: pulumi.Output<string>;
  user: string;
};

/**
 * Provisions Hysteria2 (QUIC/UDP) on the gateway VPS.
 *
 * Unlike the TCP-based Reality path, Hysteria2 runs over QUIC with
 * loss-tolerant congestion control, so it stays smooth on lossy/jittery
 * links where TCP-over-TCP melts down. Salamander obfuscation scrambles
 * the QUIC so DPI can't fingerprint it. hy2 is admin-only: auth is a per-admin
 * `userpass` map, so a guest has no credential here at all (their sole entry is
 * reality — that's what makes the guest tailnet block enforceable). The obfs
 * password is server-wide; the TLS cert is a self-signed keypair minted on the
 * box that clients trust via insecure + pinned SNI. Returns the per-admin auth
 * passwords + the shared obfs password for the client profile.
 */
export function createHysteria(
  connection: Connection,
  server: hcloud.Server,
  hysteria: z.infer<typeof HysteriaConfSchema>,
  users: VpnUser[],
  name = "",
) {
  // Empty name = the primary gateway, keeping its original resource names so
  // Pulumi doesn't replace the live box. Edges pass a name → prefixed names.
  const p = name ? `${name}-` : "";
  const admins = users.filter((u) => u.role === "admin");
  const authByAdmin = admins.map((a) => ({
    name: a.name,
    password: new random.RandomPassword(`${p}hysteria-auth-${a.name}`, {
      length: 32,
      special: false,
    }),
  }));
  const passwords: Record<string, pulumi.Output<string>> = {};
  for (const a of authByAdmin) passwords[a.name] = a.password.result;

  // YAML userpass block: "  <name>: <password>" per admin, resolved together.
  const userpassBlock = pulumi
    .all(authByAdmin.map((a) => a.password.result))
    .apply((pws) =>
      authByAdmin.map((a, i) => `    ${a.name}: ${pws[i]}`).join("\n"),
    );

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
  type: userpass
  userpass:
${userpassBlock}
HY_EOF
systemctl enable hysteria-server
systemctl restart hysteria-server`,
      triggers: [
        userpassBlock,
        obfsPassword.result,
        pulumi.interpolate`${hysteria.port}`,
      ],
    },
    { dependsOn: [install] },
  );

  return {
    config,
    obfsPassword: obfsPassword.result,
    passwords,
  };
}
