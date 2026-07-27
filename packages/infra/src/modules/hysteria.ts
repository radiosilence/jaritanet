import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { HysteriaConfSchema } from "../conf.schemas.ts";
import type { VpnUser } from "../env.schema.ts";
import { type Connection, resourcePrefix } from "./vps.ts";

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
  const p = resourcePrefix(name);
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

  // systemd instance per alt port; the port is recoverable from the name.
  const altInstances = hysteria.altPorts.map((port) => `alt-${port}`);

  const install = new command.remote.Command(
    `${p}hysteria-install`,
    {
      connection,
      create: pulumi.interpolate`set -euo pipefail
# Pulumi SSHes in the moment the server answers, which is long before the box
# is actually usable. Two separate waits are needed:
#   1. cloud-init, or directories these scripts write into do not exist yet;
#   2. the dpkg lock, because Ubuntu runs unattended-upgrades *after* cloud-init
#      finishes and holds it for minutes — every apt call here exits 100 until
#      it lets go, and the vendor install scripts give no way to pass a timeout.
# Both are idempotent and return immediately once the box has settled.
cloud-init status --wait >/dev/null 2>&1 || true
# Ubuntu runs unattended-upgrades once cloud-init finishes and holds the dpkg
# lock for minutes; every apt call exits 100 until it lets go. Telling apt
# itself to wait is the only approach that also covers the vendor install
# scripts (xray, hysteria), which shell out to apt with no flags we can pass.
# A polling loop here cannot help those, and fuser is not even installed on
# the minimal cloud image anyway.
mkdir -p /etc/apt/apt.conf.d
printf 'DPkg::Lock::Timeout "600";\n' > /etc/apt/apt.conf.d/99-lock-timeout
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
# Pulumi SSHes in the moment the server answers, which is long before the box
# is actually usable. Two separate waits are needed:
#   1. cloud-init, or directories these scripts write into do not exist yet;
#   2. the dpkg lock, because Ubuntu runs unattended-upgrades *after* cloud-init
#      finishes and holds it for minutes — every apt call here exits 100 until
#      it lets go, and the vendor install scripts give no way to pass a timeout.
# Both are idempotent and return immediately once the box has settled.
cloud-init status --wait >/dev/null 2>&1 || true
# Ubuntu runs unattended-upgrades once cloud-init finishes and holds the dpkg
# lock for minutes; every apt call exits 100 until it lets go. Telling apt
# itself to wait is the only approach that also covers the vendor install
# scripts (xray, hysteria), which shell out to apt with no flags we can pass.
# A polling loop here cannot help those, and fuser is not even installed on
# the minimal cloud image anyway.
mkdir -p /etc/apt/apt.conf.d
printf 'DPkg::Lock::Timeout "600";\n' > /etc/apt/apt.conf.d/99-lock-timeout
# Every listener is the same server on a different port, so the config is
# written by one function and the extras ride the installer's
# hysteria-server@.service template unit (reads /etc/hysteria/<instance>.yaml).
# Separate instances rather than a DNAT port-hop: no nat table to persist
# across reboots, and each port fails independently.
write_config() {
cat > "$1" << HY_EOF
listen: :$2
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
}

write_config /etc/hysteria/config.yaml ${hysteria.port}
systemctl enable hysteria-server
systemctl restart hysteria-server

# Drop instances that are no longer configured, or a removed alt port keeps
# listening until someone reboots the box.
WANTED="${altInstances.join(" ")}"
for f in /etc/hysteria/alt-*.yaml; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .yaml)
  case " $WANTED " in
    *" $n "*) ;;
    *) systemctl disable --now "hysteria-server@$n" || true; rm -f "$f" ;;
  esac
done

for n in $WANTED; do
  write_config "/etc/hysteria/$n.yaml" "\${n#alt-}"
  systemctl enable "hysteria-server@$n"
  systemctl restart "hysteria-server@$n"
done`,
      triggers: [
        userpassBlock,
        obfsPassword.result,
        pulumi.interpolate`${hysteria.port}`,
        hysteria.altPorts.join(),
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
