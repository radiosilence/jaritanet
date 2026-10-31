import {
  createAdminSshAccess,
  createAutomaticPatching,
  createK3s,
  createNetworkTuning,
  inboundRule,
} from "@jaritanet/hetzner";
import { createTailscaleSystemd } from "@jaritanet/vpn";
import * as command from "@pulumi/command";
import * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";
import type * as z from "zod";
import type { GatewayConfSchema } from "./schemas.ts";

/**
 * Provisions the Hetzner VPS the cluster and the transports run on.
 *
 * Over SSH this sets up the host: tuning, patching, admin SSH access, tailscaled
 * and k3s, and labels the node as a VPN entry, which is what the transport
 * DaemonSets select on. The transports and the DNS cache are pods in that
 * cluster, deployed from main.ts.
 *
 * Everything in `opts` is passed in rather than read from the environment here:
 * the modules this composes take their inputs as arguments, and a function that
 * reaches for `process.env` halfway down cannot be tested or reused.
 * `entryLabel` in particular is the same value the transport DaemonSets select
 * on, so it arrives from one place instead of being spelled twice.
 */
export function createGateway(
  gateway: z.infer<typeof GatewayConfSchema>,
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
      // tailscaled's direct-connection port. Without it, peers behind NAT
      // often fail to punch through and fall back to a DERP relay, which
      // caps throughput; the cluster's own traffic to the home node rides
      // the tailnet too.
      inboundRule("Tailscale direct connections", 41641, "udp"),
      // Only when the API server is not reached over the tailnet. With
      // `apiViaTailnet` the kubeconfig points at a MagicDNS name and 6443
      // needs no public rule.
      ...(!gateway.k3s.apiViaTailnet
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

  // Tailnet relay: only when configured and an auth key is present, so
  // enabling `tailnet` in config before the secret is set is a safe no-op.
  // Not a pod like the transports: this is not something the cluster serves
  // but the substrate it stands on. Cilium addresses nodes
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
    gateway.k3s.apiViaTailnet && gateway.tailnet && magicdnsSuffix
      ? `${gateway.tailnet.hostname}.${magicdnsSuffix}`
      : server.ipv4Address;

  const k3s = createK3s(
    connection,
    server,
    gateway.k3s,
    apiHost,
    clusterName,
    tailscale ? [tailscale] : [],
  );

  // Marks this node as one that serves VPN entries; the transport DaemonSets
  // select on it. Applied from here rather than as a Kubernetes resource
  // because labelling an existing node needs server-side apply, which would
  // change how every other resource in the stack is managed for the sake of one
  // key. A missing label is worth failing on: the DaemonSets would simply
  // schedule nothing, and every transport would be silently absent.
  const vpnEntryLabel = new command.remote.Command(
    "gateway-vpn-entry-label",
    {
      connection,
      create: `set -euo pipefail
k3s kubectl label node "$(hostname)" ${entryLabel}=true --overwrite`,
      delete: `k3s kubectl label node "$(hostname)" ${entryLabel}- || true`,
      triggers: [entryLabel],
    },
    { dependsOn: [k3s.install] },
  );

  return {
    apiHost,
    k3s,
    vpnEntryLabel,
    server,
    sshKey,
    tailscale,
    vpsIp: server.ipv4Address,
  };
}
