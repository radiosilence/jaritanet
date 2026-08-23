import {
  createAdminSshAccess,
  createAutomaticPatching,
  createK3s,
  createNetworkTuning,
  inboundRule,
} from "@jaritanet/hetzner";
import { remotePreamble } from "@jaritanet/remote";
import {
  createHysteriaSystemd,
  createTailscaleSystemd,
  createXraySystemd,
  type VpnUser,
} from "@jaritanet/vpn";
import * as command from "@pulumi/command";
import * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { GatewayConfSchema } from "./schemas.ts";

/**
 * Provisions the Hetzner VPS the cluster and the transports run on.
 * The VPS is completely stateless — no certs, no proxy config.
 * It just tunnels ports 80/443 from the public internet to
 * the transports and the k3s control plane, all installed over SSH.
 *
 * `users` is the per-user VPN roster threaded into the entry transports (Xray
 * clients + hy2 userpass); see @jaritanet/vpn for role enforcement.
 *
 * With `k3s` set the box runs its own cluster, and the transports, the DNS
 * cache and the tailnet relay are pods deployed from main.ts instead — so
 * nothing here installs them, and whatever a previous deploy left running as a
 * systemd unit is disabled first.
 *
 * Everything in `opts` is passed in rather than read from the environment here:
 * the modules this composes take their inputs as arguments, and a function that
 * reaches for `process.env` halfway down cannot be tested or reused.
 * `entryLabel` in particular is the same value the transport DaemonSets select
 * on, so it arrives from one place instead of being spelled twice.
 */
export function createGateway(
  gateway: z.infer<typeof GatewayConfSchema>,
  users: VpnUser[],
  {
    adminSshKey,
    clusterName,
    proToken,
    entryLabel,
    magicdnsSuffix = "",
    tailnetAuthKey,
  }: {
    adminSshKey?: string;
    clusterName: string;
    proToken?: string;
    entryLabel: string;
    magicdnsSuffix?: string;
    tailnetAuthKey?: string;
  },
) {
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

  const server = new hcloud.Server(
    "gateway",
    {
      firewallIds: [firewall.id.apply((id) => Number(id))],
      image: gateway.image,
      location: gateway.location,
      name: gateway.name,
      serverType: gateway.serverType,
      sshKeys: [hcloudSshKey.id.apply((id) => id.toString())],
      // Nothing to provision at creation: everything is installed over SSH
      // afterwards, so it can be changed without replacing the box.
      userData: "#!/bin/bash\ntrue\n",
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

  createAutomaticPatching(
    "gateway",
    connection,
    server,
    proToken ? pulumi.secret(proToken) : undefined,
  );

  if (adminSshKey) {
    createAdminSshAccess("gateway", connection, server, adminSshKey);
  }

  // With a cluster on this box the transports are pods (see modules/*-pod.ts);
  // without one they are systemd units installed over SSH, which is also what
  // every edge still uses. Both paths bind the same host ports, so exactly one
  // of them may exist.
  const sshTransports = !gateway.k3s;

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
        create: `${remotePreamble}
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

  const xray =
    gateway.xray && sshTransports
      ? createXraySystemd(connection, gateway.xray, users, {
          dependsOn: [server],
        })
      : undefined;

  const hysteria =
    gateway.hysteria && sshTransports
      ? createHysteriaSystemd(connection, gateway.hysteria, users, {
          dependsOn: [server],
        })
      : undefined;

  // Tailnet relay: only when configured and an auth key is present, so
  // enabling `tailnet` in config before the secret is set is a safe no-op.
  // Not gated on `sshTransports` like the other units: this is not a transport
  // the cluster serves but the substrate it stands on. Cilium addresses nodes
  // by their tailnet IP because the home node has no other reachable address,
  // so tailscaled has to exist before k3s installs — which rules out running it
  // as a pod in the cluster it is a precondition for.
  const tailscale =
    gateway.tailnet && tailnetAuthKey
      ? createTailscaleSystemd(
          connection,
          gateway.tailnet,
          pulumi.secret(tailnetAuthKey),
          { dependsOn: [server] },
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
    ? createK3s(
        connection,
        server,
        gateway.k3s,
        apiHost,
        "",
        clusterName,
        tailscale ? [tailscale] : [],
      )
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
k3s kubectl label node "$(hostname)" ${entryLabel}=true --overwrite`,
          delete: `k3s kubectl label node "$(hostname)" ${entryLabel}- || true`,
          triggers: [entryLabel],
        },
        { dependsOn: [k3s.install] },
      )
    : undefined;

  return {
    apiHost,
    hysteria,
    k3s,
    vpnEntryLabel,
    server,
    sshKey,
    tailscale,
    vpsIp: server.ipv4Address,
    xray,
  };
}
