import * as command from "@pulumi/command";
import * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { GatewayConfSchema } from "../conf.schemas.ts";
import { env } from "../env.ts";
import type { VpnUser } from "../env.schema.ts";
import { createHysteria } from "./hysteria.ts";
import { createK3s } from "./k3s.ts";
import { createTailscale } from "./tailscale.ts";
import { createNetworkTuning, inboundRule } from "./vps.ts";
import { createXray } from "./xray.ts";

/**
 * Provisions a Hetzner VPS running rathole as a TCP relay.
 * The VPS is completely stateless — no certs, no proxy config.
 * It just tunnels ports 80/443 from the public internet to
 * the rathole client running inside the K8s cluster.
 *
 * `users` is the per-user VPN roster threaded into the entry transports (Xray
 * clients + hy2 userpass); see xray.ts / hysteria.ts for role enforcement.
 */
export function createGateway(
  gateway: z.infer<typeof GatewayConfSchema>,
  users: VpnUser[],
  exits: { name: string; port: number }[] = [],
  magicdnsSuffix = "",
) {
  // rathole exists to reach a cluster behind NAT. With k3s on this box there is
  // nothing on the other side of the tunnel, so none of it gets installed — no
  // binary, no unit, no config, no open 2333. It is also what broke the last
  // deploy: writing /etc/rathole/server.toml before cloud-init had created it.
  const ratholeEnabled = !gateway.k3s;

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
      inboundRule("SSH", 22),
      inboundRule("HTTP", 80),
      inboundRule("HTTPS", 443),
      ...(ratholeEnabled ? [inboundRule("Rathole control channel", 2333)] : []),
      // Only when the API server has no tailnet to hide behind. With Tailscale
      // configured the kubeconfig points at a MagicDNS name and 6443 never
      // needs a public rule at all — so adding the Pi (and its tailnet) closes
      // this automatically rather than leaving a control plane exposed.
      ...(gateway.k3s && !gateway.tailnet
        ? [inboundRule("k3s API server", 6443)]
        : []),
      ...(gateway.hysteria
        ? [
            inboundRule("Hysteria2 QUIC", gateway.hysteria.port, "udp"),
            ...gateway.hysteria.altPorts.map((port) =>
              inboundRule(`Hysteria2 QUIC (alt ${port})`, port, "udp"),
            ),
          ]
        : []),
    ],
  });

  const serverConfig = pulumi.interpolate`#!/bin/bash
set -euo pipefail

# Install rathole
# Arch-detected: this box is ARM now, and a hardcoded x86_64 URL 404s, which
# fails cloud-init at this line and takes everything after it with it.
case "$(uname -m)" in
  x86_64) RATHOLE_TRIPLE=x86_64-unknown-linux-gnu ;;
  aarch64) RATHOLE_TRIPLE=aarch64-unknown-linux-musl ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL "https://github.com/rapiz1/rathole/releases/download/${gateway.ratholeVersion}/rathole-$RATHOLE_TRIPLE.zip" -o /tmp/rathole.zip
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

  const server = new hcloud.Server(
    "gateway",
    {
      firewallIds: [firewall.id.apply((id) => Number(id))],
      image: gateway.image,
      location: gateway.location,
      name: gateway.name,
      serverType: gateway.serverType,
      sshKeys: [hcloudSshKey.id.apply((id) => id.toString())],
      userData: ratholeEnabled ? serverConfig : "#!/bin/bash\ntrue\n",
    },
    {
      // NOT replaceOnChanges for serverType: within one architecture hcloud
      // resizes in place, which keeps the IP and the on-box REALITY key — so no
      // client profile changes. Only a cross-architecture move (x86 to ARM)
      // needs a new machine, and Hetzner rejects that as a resize with
      // "server type has incompatible architecture".
      //
      // deleteBeforeReplace still matters for the cases that *do* replace
      // (image, location, ssh key): Hetzner server names are unique, so the
      // default create-then-delete would collide with itself.
      deleteBeforeReplace: true,
    },
  );

  const connection = {
    host: server.ipv4Address,
    privateKey: sshKey.privateKeyOpenssh,
    user: "root",
  };

  createNetworkTuning("gateway", connection, server);

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
# Pulumi SSHes in the moment the server answers, which is long before the box
# is actually usable. Two separate waits are needed:
#   1. cloud-init, or directories these scripts write into do not exist yet;
#   2. the dpkg lock, because Ubuntu runs unattended-upgrades *after* cloud-init
#      finishes and holds it for minutes — every apt call here exits 100 until
#      it lets go, and the vendor install scripts give no way to pass a timeout.
# Both are idempotent and return immediately once the box has settled.
cloud-init status --wait >/dev/null 2>&1 || true
for _ in $(seq 1 120); do
  fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1 || break
  sleep 5
done
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

  if (ratholeEnabled) {
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
  }

  const xray = gateway.xray
    ? createXray(connection, server, gateway.xray, users)
    : undefined;

  const hysteria = gateway.hysteria
    ? createHysteria(connection, server, gateway.hysteria, users)
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

  // Reachable over the tailnet when there is one, else the public IP. The
  // certificate covers whichever is used, so the kubeconfig verifies properly
  // in both cases rather than falling back to insecure-skip-tls-verify.
  const apiHost =
    gateway.tailnet && magicdnsSuffix
      ? `${gateway.tailnet.hostname}.${magicdnsSuffix}`
      : server.ipv4Address;

  const k3s = gateway.k3s
    ? createK3s(connection, server, gateway.k3s, apiHost)
    : undefined;

  return {
    hysteria,
    k3s,
    ratholeToken,
    server,
    sshKey,
    tailscale,
    vpsIp: server.ipv4Address,
    xray,
  };
}
