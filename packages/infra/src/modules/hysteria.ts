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
 * the QUIC so DPI can't fingerprint it. The obfs password is server-wide; the
 * TLS cert is a self-signed keypair minted on the box that clients trust via
 * insecure + pinned SNI. Returns every user's auth password + the shared obfs
 * password for the client profile.
 *
 * Admins and guests get separate listeners because Hysteria2's ACL cannot see
 * who is connected — it matches addresses, ports and protocols, never the
 * authenticated name. One shared listener would therefore give a guest the
 * tailnet and the exit loopbacks (whose ports derive from exit names, so they
 * are guessable), i.e. exactly the egress-as-the-owner that guests are denied
 * at the Xray layer. So the boundary is a second process with a deny ACL, not a
 * second credential on the same one. Every listener is a `hysteria-server@`
 * template instance named `<role>-<port>`, which is also what makes the role's
 * ports independently survivable.
 */
export function createHysteria(
  connection: Connection,
  server: hcloud.Server,
  hysteria: z.infer<typeof HysteriaConfSchema>,
  users: VpnUser[],
  name = "",
) {
  const p = resourcePrefix(name);
  const auth = users.map((u) => ({
    name: u.name,
    role: u.role,
    password: new random.RandomPassword(`${p}hysteria-auth-${u.name}`, {
      length: 32,
      special: false,
    }),
  }));
  const passwords: Record<string, pulumi.Output<string>> = {};
  for (const a of auth) passwords[a.name] = a.password.result;

  // YAML userpass block: "  <name>: <password>" for that role, resolved
  // together. A role with no users gets no listener at all, so "" is unused.
  const userpassBlock = (role: VpnUser["role"]) => {
    const forRole = auth.filter((a) => a.role === role);
    return pulumi
      .all(forRole.map((a) => a.password.result))
      .apply((pws) =>
        forRole.map((a, i) => `    ${a.name}: ${pws[i]}`).join("\n"),
      );
  };

  const obfsPassword = new random.RandomPassword(`${p}hysteria-obfs`, {
    length: 32,
    special: false,
  });

  // What a guest may not reach through the tunnel: the tailnet, and anything
  // local to the gateway — the exit loopbacks live on 127.0.0.1, and the rest
  // is the box's own services. Everything unmatched falls through to direct,
  // so this is a deny-list on top of "the public internet".
  const guestDeny = [
    "100.64.0.0/10",
    "fd7a:115c:a1e0::/48",
    "127.0.0.0/8",
    "::1/128",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "fc00::/7",
  ];
  const denyBlock = guestDeny.map((cidr) => `    - reject(${cidr})`).join("\n");

  // One systemd instance per (role, port); both are recoverable from the name.
  const instancesFor = (role: VpnUser["role"], ports: number[]) =>
    auth.some((a) => a.role === role) ? ports.map((n) => `${role}-${n}`) : [];
  const adminInstances = instancesFor("admin", [
    hysteria.port,
    ...hysteria.altPorts,
  ]);
  const guestInstances = instancesFor("guest", hysteria.guestPorts);

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
# Every listener is the same server differing only in port and who may use it,
# so there is one writer per role and each rides the installer's
# hysteria-server@.service template unit (reads /etc/hysteria/<instance>.yaml).
# Separate instances rather than a DNAT port-hop: no nat table to persist across
# reboots, and each port fails independently.
write_admin() {
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
${userpassBlock("admin")}
HY_EOF
}

# Same server, minus everything a guest is not allowed to reach. Unmatched
# traffic falls through to direct, so these rejects are the whole boundary.
write_guest() {
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
${userpassBlock("guest")}
acl:
  inline:
${denyBlock}
HY_EOF
}

ADMIN="${adminInstances.join(" ")}"
GUEST="${guestInstances.join(" ")}"

# Pre-role layout: one plain unit on config.yaml plus alt-<port> instances.
# Left running it would keep serving admin credentials on ports this run no
# longer manages.
systemctl disable --now hysteria-server 2>/dev/null || true
rm -f /etc/hysteria/config.yaml
for f in /etc/hysteria/alt-*.yaml; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .yaml)
  systemctl disable --now "hysteria-server@$n" 2>/dev/null || true
  rm -f "$f"
done

# Drop instances no longer configured, or a removed port (or a demoted role)
# keeps listening until someone reboots the box.
for f in /etc/hysteria/admin-*.yaml /etc/hysteria/guest-*.yaml; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .yaml)
  case " $ADMIN $GUEST " in
    *" $n "*) ;;
    *) systemctl disable --now "hysteria-server@$n" 2>/dev/null || true; rm -f "$f" ;;
  esac
done

for n in $ADMIN; do
  write_admin "/etc/hysteria/$n.yaml" "\${n#admin-}"
  systemctl enable "hysteria-server@$n"
  systemctl restart "hysteria-server@$n"
done
for n in $GUEST; do
  write_guest "/etc/hysteria/$n.yaml" "\${n#guest-}"
  systemctl enable "hysteria-server@$n"
  systemctl restart "hysteria-server@$n"
done`,
      triggers: [
        userpassBlock("admin"),
        userpassBlock("guest"),
        obfsPassword.result,
        adminInstances.join(),
        guestInstances.join(),
        denyBlock,
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
