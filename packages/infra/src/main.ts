import {
  createBlueskyRecords,
  createFastmailRecords,
  createServiceRecord,
} from "@jaritanet/dns";
import { createCilium, createK3sUpgrades } from "@jaritanet/hetzner";
import { createIngress, createRedirectMiddleware } from "@jaritanet/ingress";
import {
  createExit,
  createHysteria,
  createUnbound,
  createXray,
  deriveExitPort,
  type SingboxNode,
  type VpnUser,
} from "@jaritanet/vpn";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import { conf, vpnUsers } from "./conf.ts";
import { GatewayConfSchema } from "./conf.schemas.ts";
import { createEdge } from "./edge.ts";
import { createGateway } from "./gateway.ts";
import { createServices } from "./services.ts";
import { createTailnetPolicy } from "./tailnet-policy.ts";

export default async function () {
  const { namespace } = conf;
  let dnsTarget: pulumi.Output<string> | undefined;
  let gatewayProvider: string | undefined;
  // Set when the gateway runs its own control plane; its kubeconfig then
  // replaces the KUBE_* secrets below.
  let gatewayK3s: ReturnType<typeof createGateway>["k3s"];
  let gatewayConf: z.infer<typeof GatewayConfSchema> | undefined;
  let gatewayIp: pulumi.Output<string> | undefined;
  // Where the API server answers. Cilium needs it too, and must agree with the
  // kubeconfig — see createCilium.
  let gatewayApiHost: ReturnType<typeof createGateway>["apiHost"] | undefined;
  // Ordering for the transport DaemonSets: the legacy daemons must be gone
  // before anything tries to bind their ports, and the node must carry the
  // entry label before a DaemonSet has anywhere to schedule.
  let transportDeps: pulumi.Resource[] = [];

  // The primary gateway's transport parameters, from whichever of the two
  // implementations is in play — SSH-provisioned units, or pods in its own
  // cluster. Same shapes either way, so the client profile cannot tell.
  let reality: SingboxNode["reality"] | undefined;
  let hysteria: SingboxNode["hysteria"] | undefined;

  // sing-box nodes for the edges. The primary is prepended once its transports
  // are known, so it leads the picker.
  const edgeNodes: SingboxNode[] = [];

  // The VPN roster. No `vpnUsers` → a single implicit owner-admin, so the
  // multi-user path is exercised uniformly and old single-owner deploys keep
  // full access. A trailing `+` in the secret marks an admin; the rest are guests.
  const users: VpnUser[] =
    vpnUsers.length > 0 ? vpnUsers : [{ name: "owner", role: "admin" }];

  // Resolve each exit's host port once (derived from the name unless set), so
  // the identical port is used at the ss server and the client outbound.
  // Uniqueness is asserted per node, not globally: the port is bound on the
  // exit's own host, so two exits only clash when they share a machine.
  const resolvedExits = conf.exits.map((e) => ({
    image: e.image,
    method: e.method,
    name: e.name,
    node: e.node,
    nodeLabel: e.nodeLabel,
    port: e.port ?? deriveExitPort(e.name),
    server: e.server,
  }));
  const exitBinds = resolvedExits.map((e) => `${e.node}:${e.port}`);
  if (new Set(exitBinds).size !== exitBinds.length) {
    throw new Error(
      "two exits share a node and a port — set an explicit `port` on the clashing exit",
    );
  }
  // Exits are reached over the tailnet, and every entry's membership is gated on
  // this key (see createEdge). Without it the profile still offers every
  // entry × exit pair and not one of them can connect, so this is a red preview
  // rather than an exit axis that is present and dead.
  if (resolvedExits.length && !conf.tailnet.authKey) {
    throw new Error(
      "exits need `tailnet.authKey`: an entry with no tailnet cannot reach one",
    );
  }

  if (conf.gateway?.hcloudToken) {
    gatewayConf = conf.gateway ?? GatewayConfSchema.parse({});
    const gw = createGateway(gatewayConf, users, {
      adminSshKey: conf.adminSshKey,
      clusterName: namespace,
      proToken: conf.ubuntuProToken,
      entryLabel: conf.vpnEntryLabel,
      magicdnsSuffix: conf.tailnet.magicdnsSuffix,
      tailnetAuthKey: conf.tailnet.authKey,
    });
    dnsTarget = gw.vpsIp;
    gatewayIp = gw.vpsIp;
    gatewayProvider = "hetzner";
    gatewayK3s = gw.k3s;
    gatewayApiHost = gw.apiHost;
    transportDeps = [gw.vpnEntryLabel].filter((r) => r !== undefined);

    if (gw.xray && gatewayConf.xray) {
      reality = {
        publicKey: gw.xray.publicKey,
        serverNames: gatewayConf.xray.serverNames,
        shortId: gw.xray.shortId,
        uuids: gw.xray.uuids,
      };
    }
    if (gw.hysteria && gatewayConf.hysteria) {
      hysteria = {
        altPorts: gatewayConf.hysteria.altPorts,
        obfsPassword: gw.hysteria.obfsPassword,
        passwords: gw.hysteria.passwords,
        port: gatewayConf.hysteria.port,
        sni: gatewayConf.hysteria.sni,
      };
    }

    // Edge boxes — pure VPN nodes. Each gets a <name>.<zone> A record and a
    // picker entry. Tailnet relay only when `tailnet.authKey` is present.
    const edgeAuthKey = conf.tailnet.authKey
      ? pulumi.secret(conf.tailnet.authKey)
      : undefined;
    for (const edge of conf.edges) {
      const e = createEdge(
        edge,
        users,
        edgeAuthKey,
        conf.adminSshKey,
        conf.ubuntuProToken,
      );
      const hostname = `${edge.name}.${edge.zone}`;
      const zone = conf.zones.find((z) => z.name === edge.zone);
      if (zone) {
        createServiceRecord(e.vpsIp, zone, hostname);
      }
      edgeNodes.push({
        name: edge.name,
        // The literal IP, not `hostname`: the profile detours every resolver
        // through the tunnel, so resolving an edge's name needs the tunnel that
        // needs the name. The A record stays for humans.
        server: e.vpsIp,
        hysteria: {
          altPorts: edge.hysteria.altPorts,
          obfsPassword: e.hysteria.obfsPassword,
          passwords: e.hysteria.passwords,
          port: edge.hysteria.port,
          sni: edge.hysteria.sni,
        },
        reality: {
          publicKey: e.xray.publicKey,
          serverNames: [edge.reality.serverName],
          shortId: e.xray.shortId,
          uuids: e.xray.uuids,
        },
      });
    }
  }

  // Tailnet policy as code — only once an OAuth client exists, so this is a
  // no-op until the secrets are set (and even then the provider refuses to
  // touch a policy nobody has imported).
  if (conf.tailnet.oauth && conf.tailnet.name) {
    createTailnetPolicy(
      pulumi.secret(conf.tailnet.oauth.clientId),
      pulumi.secret(conf.tailnet.oauth.clientSecret),
      conf.tailnet.name,
    );
  }

  // --- DNS: zone modules (fastmail, bluesky) ---
  for (const zone of conf.zones) {
    for (const mod of zone.modules) {
      if (mod === "fastmail") {
        createFastmailRecords(zone, conf.fastmail);
      } else {
        createBlueskyRecords(zone, conf.bluesky);
      }
    }
  }

  // --- Kubernetes provider ---
  // The cluster runs on the gateway itself, and the same `pulumi up` that
  // creates the server produces this kubeconfig — no secret round-trip, and
  // nothing for a human to rotate. See modules/k3s.ts.
  if (!gatewayK3s) {
    throw new Error("gateway.k3s is required: it provides the cluster");
  }
  const kubeconfig = gatewayK3s.kubeconfig;

  const provider = new k8s.Provider(
    "provider",
    { kubeconfig, namespace },
    {
      customTimeouts: {
        create: "5m",
        delete: "5m",
        update: "5m",
      },
    },
  );

  // The cluster has no CNI until this exists — k3s runs with
  // --flannel-backend=none so Cilium can own networking and the
  // NetworkPolicies in this repo finally mean something.
  const cilium =
    gatewayK3s && gatewayConf?.k3s && gatewayApiHost
      ? createCilium(provider, gatewayConf.k3s.ciliumVersion, gatewayApiHost, [
          gatewayK3s.install,
        ])
      : undefined;

  // Carries `k3s.version` to nodes Pulumi never installed — a seeded agent has
  // no SSH connection here and would otherwise stay on whatever it was flashed
  // with forever. Gated on the CNI because the controller is an ordinary
  // Deployment and stays Pending without one.
  if (gatewayConf?.k3s && cilium) {
    createK3sUpgrades(provider, gatewayConf.k3s, [cilium]);
  }

  // Every resource below takes its namespace from this output rather than the
  // bare string, so Pulumi orders them after it. With a literal there is no
  // edge at all: on a cluster that already had the namespace that was invisible,
  // and on a fresh one it presents as `namespaces "jaritanet" not found` on
  // about forty resources at once.
  const ns = new k8s.core.v1.Namespace(
    namespace,
    {
      metadata: {
        annotations: { "pulumi.com/managed-by": conf.managedBy },
        labels: {
          name: namespace,
          "kubernetes.io/metadata.name": namespace,
        },
        name: namespace,
      },
    },
    // Gating the namespace on the CNI gates everything in it, since every
    // resource below now descends from this one. Not because a Namespace needs
    // networking — it does not — but because Pulumi awaits Deployment
    // readiness, and without a CNI every pod stays Pending until its create
    // times out. Racing a one-minute install against a five-minute timeout is
    // a race that is usually won, which is the worst kind.
    { provider, dependsOn: cilium ? [cilium] : [] },
  );
  const nsName = ns.metadata.name;

  // Egress exit nodes: ss-rust pinned by node label, hostNetwork, dialled at
  // that node's tailnet address by whichever entry the client picked.
  const exits = resolvedExits.map((e) => createExit(provider, nsName, e));

  // --- Ingress: Traefik. The cluster runs on the gateway, so xray relays
  // straight to Traefik's hostPort rather than through a tunnel.
  const { traefikRelease } = createIngress(
    provider,
    nsName,
    conf.traefik,
    conf.cloudflare.apiToken,
  );

  createRedirectMiddleware(provider, nsName, traefikRelease);

  // --- The gateway's own transports, in the cluster on the box they front ---
  // Tailscale is not among them: pod networking is addressed by tailnet IP, so
  // it has to exist before the cluster does — see createGateway.
  //
  // All hostNetwork, so xray owns the host's :443 and relays anything that is
  // not a VPN client to 127.0.0.1:8443 — Traefik's hostPort, just above. That
  // loopback only means the host's when the pod shares its netns, which is also
  // what lets unbound answer 127.0.0.1:53 for tunnelled clients and tailscale0
  // exist where the other two dial 100.x.
  //
  // All DaemonSets selecting the entry label, so which node carries an entry is
  // a property of the node — see transportDeps for the ordering they need.
  if (gatewayConf) {
    createUnbound(
      provider,
      nsName,
      gatewayConf.unbound,
      conf.vpnEntryLabel,
      transportDeps,
    );

    if (gatewayConf.xray) {
      const t = createXray(
        provider,
        nsName,
        gatewayConf.xray,
        users,
        conf.vpnEntryLabel,
        gatewayConf.credentialRotation,
        transportDeps,
      );
      reality = {
        publicKey: t.publicKey,
        serverNames: gatewayConf.xray.serverNames,
        shortId: t.shortId,
        uuids: t.uuids,
      };
    }

    if (gatewayConf.hysteria) {
      const t = createHysteria(
        provider,
        nsName,
        gatewayConf.hysteria,
        users,
        conf.vpnEntryLabel,
        gatewayConf.credentialRotation,
        transportDeps,
      );
      hysteria = {
        altPorts: gatewayConf.hysteria.altPorts,
        obfsPassword: t.obfsPassword,
        passwords: t.passwords,
        port: gatewayConf.hysteria.port,
        sni: gatewayConf.hysteria.sni,
      };
    }
  }

  // --- Everything that runs in the cluster ---
  // One loop over `conf.services`, dispatched by `kind` — the web containers,
  // the file services on the box holding the disks, the MCP gateway, and the
  // sing-box profile server. Nothing here selects the gateway: the file
  // services carry no VPN entry label, so a DaemonSet with no matching node
  // schedules nothing rather than landing somewhere it would fight the
  // transports for a host port.
  //
  // The primary is a sing-box node too: clients connect by IP, and its REALITY
  // decoy is its own reverse-proxied site (unlike edges, which use an external
  // one). It leads the list so it heads the entry picker.
  const singboxNodes: SingboxNode[] = [
    ...(gatewayIp && reality && hysteria
      ? [{ name: "primary", server: gatewayIp, hysteria, reality }]
      : []),
    ...edgeNodes,
  ];

  const services = createServices(
    {
      provider,
      namespace: nsName,
      zones: conf.zones,
      dnsTarget,
      traefik: traefikRelease,
      credentialRotation: gatewayConf?.credentialRotation ?? "1",
      exits,
      magicdnsSuffix: conf.tailnet.magicdnsSuffix,
      singboxNodes,
      users,
    },
    conf.services,
  );

  return {
    ...(gatewayProvider && { gatewayProvider }),
    namespace,
    services,
    ...(dnsTarget && { vpsIp: dnsTarget }),
    // Per-user credentials + share URLs are now delivered as individual sing-box
    // profiles (see createProfileServer), so only the shared, non-secret
    // REALITY params are surfaced as stack outputs.
    // So the cluster can be reached with kubectl without SSHing in first:
    //   pulumi stack output kubeconfig --show-secrets > ~/.kube/jaritanet
    // Secret, because it is full cluster admin.
    ...(gatewayK3s && { kubeconfig: gatewayK3s.kubeconfig }),
    ...(reality && {
      xrayPublicKey: reality.publicKey,
      xrayServerNames: reality.serverNames,
      xrayShortId: reality.shortId,
    }),
  };
}
