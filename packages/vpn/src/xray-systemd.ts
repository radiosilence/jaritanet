import { remotePreamble } from "@jaritanet/remote";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { XrayConfSchema } from "./xray.schemas.ts";
import type { VpnUser } from "./users.ts";
import { resourcePrefix, type SshConnection, type SystemdOpts } from "./ssh.ts";
import { GUEST_DENY_CIDRS } from "./xray.ts";
import { XRAY_VERSION } from "./versions.ts";

/**
 * Provisions Xray-core (VLESS-Vision-REALITY) on the gateway VPS.
 *
 * Xray takes :443; traffic that doesn't match a client is relayed to `dest`
 * (Traefik's local https port), matched clients are
 * proxied out. Keys are minted on first boot and never leave the box: the
 * x25519 private key stays in /usr/local/etc/xray, and one REALITY UUID is
 * minted per user (`email: <name>`) so a user is revoked by dropping them from
 * the clients list. Guests (reality-only) are blackholed server-side to the
 * tailnet CIDR — which is where the exits live too — and every other address
 * that is not the internet. A hard block, not a profile omission.
 *
 * `user`-scoped routing only resolves once the inbound sniffs the flow, so the
 * inbound enables sniffing with `routeOnly` (route on the sniffed destination
 * without rewriting it). Outbounds are tagged (`direct` freedom, `block`
 * blackhole) and routing ends in an explicit `direct` default, so a non-guest
 * (matching no rule) proxies out cleanly instead of relying on ordering.
 * Returns the shared REALITY params plus each user's per-node UUID.
 */
export function createXraySystemd(
  connection: SshConnection,
  xray: z.infer<typeof XrayConfSchema>,
  users: VpnUser[],
  { name = "", dependsOn = [] }: SystemdOpts = {},
) {
  const p = resourcePrefix(name);
  const shortId = new random.RandomId(`${p}xray-short-id`, { byteLength: 8 });

  // One UUID per user, keyed on the (stable) user name so adding/removing a user
  // only churns that user's resource. `email` tags the client for routing rules.
  const clients = users.map((u) => ({
    role: u.role,
    name: u.name,
    uuid: new random.RandomUuid(`${p}xray-uuid-${u.name}`),
  }));
  const uuids: Record<string, pulumi.Output<string>> = {};
  for (const c of clients) uuids[c.name] = c.uuid.result;

  const clientsJson = pulumi
    .all(clients.map((c) => c.uuid.result))
    .apply((ids) =>
      JSON.stringify(
        clients.map((c, i) => ({
          id: ids[i],
          email: c.name,
          flow: "xtls-rprx-vision",
        })),
      ),
    );

  // Guest hard-block, keyed on the client's `email` (= user name), which is the
  // per-user dimension Xray gives us and hy2 does not. Admins match no guest
  // rule and fall through to `direct`.
  //
  // These are IP rules, so they are only worth anything with a domainStrategy
  // that resolves: under `AsIs` an IP rule never matches a request whose
  // destination is a *domain*, and a guest editing their own profile to dial a
  // hostname they control — A record pointing into the tailnet — walked straight
  // past this into the mesh. `IPIfNonMatch` resolves after a non-matching round
  // and matches again, which is what makes the rule mean what it looks like.
  const guests = clients.filter((c) => c.role === "guest").map((c) => c.name);
  const guestsList = JSON.stringify(guests);
  const guestRules = guests.length
    ? `
      { "user": ${guestsList}, "ip": ${JSON.stringify(GUEST_DENY_CIDRS)}, "outboundTag": "block" },`
    : "";

  const install = new command.remote.Command(
    `${p}xray-install`,
    {
      connection,
      create: pulumi.interpolate`${remotePreamble}
export DEBIAN_FRONTEND=noninteractive
XRAY_VERSION=${XRAY_VERSION}

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
      triggers: [`v${XRAY_VERSION}`],
    },
    { dependsOn },
  );

  // Read back the minted public key so clients can be configured.
  const publicKey = new command.remote.Command(
    `${p}xray-public-key`,
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
    `${p}xray-config`,
    {
      connection,
      create: pulumi.interpolate`${remotePreamble}
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
        "clients": ${clientsJson},
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "${xray.dest}",
          "xver": 0,
          "serverNames": ${JSON.stringify(xray.serverNames)},
          "privateKey": "$PRIV",
          "shortIds": ["${shortId.hex}"]
        }
      },
      "sniffing": {
        "enabled": true,
        "destOverride": ["http", "tls", "quic"],
        "routeOnly": true
      }
    }
  ],
  "outbounds": [
    { "protocol": "freedom", "tag": "direct" },
    { "protocol": "blackhole", "tag": "block" }
  ],
  "routing": {
    "domainStrategy": "IPIfNonMatch",
    "rules": [${guestRules}
      { "network": "tcp,udp", "outboundTag": "direct" }
    ]
  }
}
XRAY_EOF
systemctl restart xray`,
      triggers: [
        clientsJson,
        guestsList,
        GUEST_DENY_CIDRS.join(),
        shortId.hex,
        xray.serverNames.join(),
        xray.dest,
        publicKey.stdout,
      ],
    },
    { dependsOn: [publicKey] },
  );

  return {
    config,
    publicKey: publicKey.stdout,
    shortId: shortId.hex,
    uuids,
  };
}
