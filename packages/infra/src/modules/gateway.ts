import * as command from "@pulumi/command";
import * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { GatewayConfSchema } from "../conf.schemas.ts";
import { env } from "../env.ts";
import type { VpnUser } from "../env.schema.ts";
import { createHysteriaSystemd } from "./hysteria-systemd.ts";
import { createK3s } from "./k3s.ts";
import { createTailscaleSystemd } from "./tailscale-systemd.ts";
import { createNetworkTuning, inboundRule } from "./vps.ts";
import { createXraySystemd } from "./xray-systemd.ts";
import { VPN_ENTRY_LABEL } from "../util.ts";

/**
 * Provisions a Hetzner VPS running rathole as a TCP relay.
 * The VPS is completely stateless — no certs, no proxy config.
 * It just tunnels ports 80/443 from the public internet to
 * the rathole client running inside the K8s cluster.
 *
 * `users` is the per-user VPN roster threaded into the entry transports (Xray
 * clients + hy2 userpass); see xray.ts / hysteria.ts for role enforcement.
 *
 * With `k3s` set the box runs its own cluster, and the transports, the DNS
 * cache and the tailnet relay are pods deployed from main.ts instead — so
 * nothing here installs them, and whatever a previous deploy left running as a
 * systemd unit is disabled first.
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
      ...(gateway.k3s && !gateway.k3s.apiViaTailnet
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

  // With a cluster on this box the transports are pods (see modules/*-pod.ts);
  // without one they are systemd units installed over SSH, which is also what
  // every edge still uses. Both paths bind the same host ports, so exactly one
  // of them may exist.
  const sshTransports = !gateway.k3s;

  // Uninstalls the daemons this box ran before the cluster did, so it ends up
  // as k3s and nothing else. Dropping a remote Command from the Pulumi program
  // runs nothing on the machine, so without this a migrated gateway keeps its
  // old xray holding :443 while the pod that wants it never binds. Every pod
  // depends on this, so none of them races a daemon that is still up.
  //
  // Removed rather than stopped or masked: a stopped unit is one package
  // upgrade, postinst or curious human away from coming back, and it would come
  // back onto a port a pod is holding. The vendor uninstalls are preferred over
  // hand-deleting so unit files, logrotate config and /usr/local/etc/xray go
  // with the binary.
  //
  // tailscale is `remove`, never `purge`, and the difference is load-bearing:
  // the pod inherits this node's tailnet identity from /var/lib/tailscale, and
  // purge takes that directory with it. The node would rejoin as a new machine
  // needing a fresh authkey — the cluster up but unreachable, which is the one
  // failure this migration must not produce.
  const legacyUnits = gateway.k3s
    ? new command.remote.Command(
        "gateway-legacy-units",
        {
          connection,
          create: `set -uo pipefail

# apt here contends with unattended-upgrades, which holds the dpkg lock for
# minutes. Telling apt to wait is the only lever that also covers the vendor
# uninstall scripts, which shell out to apt with flags we cannot pass.
mkdir -p /etc/apt/apt.conf.d
printf 'DPkg::Lock::Timeout "600";\n' > /etc/apt/apt.conf.d/99-lock-timeout
export DEBIAN_FRONTEND=noninteractive

# Stop everything first so the ports are free while the uninstalls run. Every
# step tolerates the unit never having existed: on a box built after this
# change the whole command is a no-op, not a reason to abort the deploy.
stop_unit() {
  systemctl stop "$1" >/dev/null 2>&1 || true
  systemctl disable "$1" >/dev/null 2>&1 || true
}
for unit in xray hysteria-server unbound unbound-resolvconf tailscaled; do
  stop_unit "$unit"
done
# The alt ports (3478, 4500) run as instances of a template unit, which the
# vendor uninstall does not know about — it only handles the base one.
for unit in $(systemctl list-units --all --plain --no-legend 'hysteria-server@*' | awk '{print $1}'); do
  stop_unit "$unit"
done

# Same installers xray.ts and hysteria.ts used, in their removal mode. Both
# exit non-zero when their package was never there.
bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ remove --purge >/dev/null 2>&1 || true
bash -c "$(curl -fsSL https://get.hy2.sh/)" -- --remove >/dev/null 2>&1 || true
rm -rf /etc/hysteria /etc/systemd/system/hysteria-server@.service

# One apt call per package: an unknown name aborts the whole invocation without
# removing anything, and this list is partly what was found on the box rather
# than what the code installed.
for pkg in unbound unbound-anchor unbound-resolvconf; do
  apt-get purge -y "$pkg" >/dev/null 2>&1 || true
done
rm -rf /etc/unbound

# remove, not purge — see above. tailscale-archive-keyring is left alone: it is
# inert, and removing it would only make a future reinstall harder.
if [ -f /var/lib/tailscale/tailscaled.state ]; then
  rm -rf /var/lib/tailscale.premigrate
  cp -a /var/lib/tailscale /var/lib/tailscale.premigrate
fi
apt-get remove -y tailscale >/dev/null 2>&1 || true
# Belt and braces, in case the packaging ever stops respecting remove/purge.
if [ -d /var/lib/tailscale.premigrate ] && [ ! -f /var/lib/tailscale/tailscaled.state ]; then
  mkdir -p /var/lib/tailscale
  cp -a /var/lib/tailscale.premigrate/. /var/lib/tailscale/
fi
if [ -d /var/lib/tailscale.premigrate ] && [ ! -f /var/lib/tailscale/tailscaled.state ]; then
  echo "tailscale node state did not survive removal — the relay would rejoin as a new machine" >&2
  exit 1
fi

systemctl daemon-reload >/dev/null 2>&1 || true
sleep 2

# Assert the end state rather than assume it, because the failure mode is
# invisible from kubectl: these pods are hostNetwork, not hostPort, so they bind
# in this very namespace. A surviving daemon means one process keeps the port,
# the other never serves, and the pod still reports Running.
leftovers=""
for bin in xray hysteria tailscale tailscaled unbound; do
  found=$(command -v "$bin" 2>/dev/null || true)
  if [ -n "$found" ]; then leftovers="$leftovers $found"; fi
done
if [ -n "$leftovers" ]; then
  echo "legacy daemons still installed:$leftovers" >&2
  exit 1
fi

# Anything under kubepods is one of ours — this command re-runs after the pods
# exist, and their listeners are exactly the ones that must not count.
# systemd-resolved is not a conflict either: it holds 127.0.0.53:53, a different
# address from unbound's 127.0.0.1:53.
listeners() {
  ss -Hlnptu "$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2
}
held=""
for pid in $( { listeners 'sport = :443'; listeners 'sport = :3478'; listeners 'sport = :4500'; listeners 'src 127.0.0.1:53'; } | sort -u ); do
  grep -q kubepods "/proc/$pid/cgroup" 2>/dev/null && continue
  held="$held $pid($(cat "/proc/$pid/comm" 2>/dev/null || echo unknown))"
done
if [ -n "$held" ]; then
  echo "host processes still holding VPN ports:$held" >&2
  ss -lnptu 'sport = :443 or sport = :3478 or sport = :4500' >&2 || true
  exit 1
fi`,
          triggers: ["legacy-units-v3"],
        },
        { dependsOn: [server] },
      )
    : undefined;

  // Caching DNS forwarder on loopback. Clients dial 127.0.0.1:53 *at this box*
  // through the tunnel (a DNS server with detour=entry-select), so unbound has
  // zero public attack surface — reachable only from inside the tunnel. It
  // forwards upstream to Cloudflare over DoT (:853), so there is no cleartext
  // DNS anywhere in the chain: client→gateway is the encrypted tunnel, and
  // gateway→resolver is TLS. Prefetch + serve-expired keep the hot set warm, so
  // a client-cache miss is answered from this Germany-local cache in one tunnel
  // RTT instead of a round trip to the upstream from the client's location.
  if (sshTransports) {
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
# Ubuntu runs unattended-upgrades once cloud-init finishes and holds the dpkg
# lock for minutes; every apt call exits 100 until it lets go. Telling apt
# itself to wait is the only approach that also covers the vendor install
# scripts (xray, hysteria), which shell out to apt with no flags we can pass.
# A polling loop here cannot help those, and fuser is not even installed on
# the minimal cloud image anyway.
mkdir -p /etc/apt/apt.conf.d
printf 'DPkg::Lock::Timeout "600";\n' > /etc/apt/apt.conf.d/99-lock-timeout
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
  }

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

  const xray =
    gateway.xray && sshTransports
      ? createXraySystemd(connection, server, gateway.xray, users)
      : undefined;

  const hysteria =
    gateway.hysteria && sshTransports
      ? createHysteriaSystemd(connection, server, gateway.hysteria, users)
      : undefined;

  // Tailnet relay: only when configured and an auth key is present, so
  // enabling `tailnet` in config before the secret is set is a safe no-op.
  const tailscale =
    gateway.tailnet && env.TS_AUTHKEY && sshTransports
      ? createTailscaleSystemd(
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
    gateway.k3s?.apiViaTailnet && gateway.tailnet && magicdnsSuffix
      ? `${gateway.tailnet.hostname}.${magicdnsSuffix}`
      : server.ipv4Address;

  const k3s = gateway.k3s
    ? createK3s(connection, server, gateway.k3s, apiHost)
    : undefined;

  // Marks this node as one that serves VPN entries; the transport DaemonSets
  // select on it. Applied from here rather than as a Kubernetes resource
  // because labelling an existing node needs server-side apply, which would
  // change how every other resource in the stack is managed for the sake of one
  // key. A missing label is worth failing on: the DaemonSets would simply
  // schedule nothing, and every transport would be silently absent.
  const vpnEntryLabel = k3s
    ? new command.remote.Command(
        "gateway-vpn-entry-label",
        {
          connection,
          create: `set -euo pipefail
k3s kubectl label node "$(hostname)" ${VPN_ENTRY_LABEL}=true --overwrite`,
          delete: `k3s kubectl label node "$(hostname)" ${VPN_ENTRY_LABEL}- || true`,
          triggers: [VPN_ENTRY_LABEL],
        },
        { dependsOn: [k3s.install] },
      )
    : undefined;

  return {
    hysteria,
    k3s,
    legacyUnits,
    vpnEntryLabel,
    ratholeToken,
    server,
    sshKey,
    tailscale,
    vpsIp: server.ipv4Address,
    xray,
  };
}
