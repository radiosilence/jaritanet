import { remotePreamble } from "@jaritanet/remote";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { HysteriaConfSchema } from "./hysteria.schemas.ts";
import type { VpnUser } from "./users.ts";
import { resourcePrefix, type SshConnection, type SystemdOpts } from "./ssh.ts";

/**
 * Provisions Hysteria2 (QUIC/UDP) on the gateway VPS.
 *
 * Unlike the TCP-based Reality path, Hysteria2 runs over QUIC with
 * loss-tolerant congestion control, so it stays smooth on lossy/jittery
 * links where TCP-over-TCP melts down. Salamander obfuscation scrambles
 * the QUIC so DPI can't fingerprint it. hy2 is admin-only: auth is a per-admin
 * `userpass` map, so a guest has no credential here at all (their sole entry is
 * reality — that's what makes the guest tailnet block enforceable). The obfs
 * password is server-wide; the TLS cert is self-signed by Pulumi, written to the
 * box, and pinned in every profile, as in createHysteria. Returns the per-admin
 * auth passwords, the shared obfs password and the cert for the client profile.
 */
export function createHysteriaSystemd(
  connection: SshConnection,
  hysteria: z.infer<typeof HysteriaConfSchema>,
  users: VpnUser[],
  { name = "", dependsOn = [], replaceWith = [] }: SystemdOpts = {},
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

  const key = new tls.PrivateKey(`${p}hysteria-key`, {
    algorithm: "ECDSA",
    ecdsaCurve: "P256",
  });
  const cert = new tls.SelfSignedCert(`${p}hysteria-cert`, {
    privateKeyPem: key.privateKeyPem,
    allowedUses: ["digital_signature", "key_encipherment", "server_auth"],
    dnsNames: [hysteria.sni],
    subject: { commonName: hysteria.sni },
    validityPeriodHours: 24 * 365 * 10,
  });

  // systemd instance per alt port; the port is recoverable from the name.
  const altInstances = hysteria.altPorts.map((port) => `alt-${port}`);

  const install = new command.remote.Command(
    `${p}hysteria-install`,
    {
      connection,
      create: pulumi.interpolate`${remotePreamble}
# Official installer: binary + hysteria-server.service systemd unit.
bash -c "$(curl -fsSL https://get.hy2.sh/)"
mkdir -p /etc/hysteria`,
      triggers: ["hysteria-v1"],
    },
    { dependsOn, replaceWith },
  );

  const config = new command.remote.Command(
    `${p}hysteria-config`,
    {
      connection,
      create: pulumi.interpolate`${remotePreamble}
(
umask 077
cat > /etc/hysteria/cert.pem << 'PEM_EOF'
${cert.certPem}
PEM_EOF
cat > /etc/hysteria/key.pem << 'PEM_EOF'
${key.privateKeyPem}
PEM_EOF
)
chown hysteria:hysteria /etc/hysteria/key.pem /etc/hysteria/cert.pem 2>/dev/null || true

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
        cert.certPem,
        userpassBlock,
        obfsPassword.result,
        pulumi.interpolate`${hysteria.port}`,
        hysteria.altPorts.join(),
      ],
    },
    { dependsOn: [install], replaceWith },
  );

  return {
    // Through `config`, so no profile pins this cert before the box serves it.
    certificate: pulumi
      .all([cert.certPem, config.stdout])
      .apply(([pem]) => pem),
    config,
    obfsPassword: obfsPassword.result,
    passwords,
  };
}
