import {
  createBlueskyRecords,
  createFastmailRecords,
  createServiceRecord,
} from "@jaritanet/dns";
import { createCilium, createK3sUpgrades } from "@jaritanet/hetzner";
import { createSamba, createSyncthing } from "@jaritanet/home";
import {
  createIngress,
  createIngressRoute,
  createRedirectMiddleware,
} from "@jaritanet/ingress";
import { createService } from "@jaritanet/k8s";
import { createMcpGateway } from "@jaritanet/mcp-gateway";
import {
  createExit,
  createHysteria,
  createProfileServer,
  createTailscale,
  createUnbound,
  createXray,
  deriveExitPort,
  type SingboxNode,
  type VpnUser,
} from "@jaritanet/vpn";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import { conf, vpnUsers } from "./conf.ts";
import { GatewayConfSchema } from "./conf.schemas.ts";
import { createEdge } from "./edge.ts";
import { createGateway } from "./gateway.ts";
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
  // are known — buildProfile detours exits through nodes[0], so the order is
  // load-bearing.
  const edgeNodes: SingboxNode[] = [];

  // The VPN roster. No `vpnUsers` → a single implicit owner-admin, so the
  // multi-user path is exercised uniformly and old single-owner deploys keep
  // full access. A trailing `+` in the secret marks an admin; the rest are guests.
  const users: VpnUser[] =
    vpnUsers.length > 0 ? vpnUsers : [{ name: "owner", role: "admin" }];

  // Resolve each exit's loopback port once (derived from the name unless set),
  // so the identical port is used at the ss server and the client outbound.
  // Assert uniqueness — a clash means the user
  // should set an explicit `port` on one of the exits.
  const resolvedExits = conf.exits.map((e) => ({
    image: e.image,
    method: e.method,
    name: e.name,
    port: e.port ?? deriveExitPort(e.name),
  }));
  if (new Set(resolvedExits.map((e) => e.port)).size !== resolvedExits.length) {
    throw new Error(
      "exit loopback port collision — set an explicit `port` on the clashing exit",
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

  // Egress exit nodes: ss-rust in-cluster, bound to the gateway's loopback.
  // Clients reach them by detouring through the primary, which is that host.
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

    if (gatewayConf.tailnet && conf.tailnet.authKey) {
      createTailscale(
        provider,
        nsName,
        gatewayConf.tailnet,
        pulumi.secret(conf.tailnet.authKey),
        conf.vpnEntryLabel,
        transportDeps,
      );
    }

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

  // --- Home node: file shares and media tooling, on the box holding the disks
  // Inert without a `home` block, which is the state until that machine exists.
  // Nothing here selects the gateway: these carry no VPN entry label, so a
  // DaemonSet with no matching node schedules nothing rather than landing
  // somewhere it would fight the transports for a host port.
  if (conf.home?.samba) {
    createSamba(provider, nsName, conf.home.samba, conf.home.nodeLabel);
  }

  if (conf.home?.syncthing) {
    createSyncthing(provider, nsName, conf.home.syncthing, conf.home.nodeLabel);
    // The web UI, published like any other service when a hostname is set.
    const host = conf.home.syncthing.hostname;
    if (host) {
      const zone = conf.zones.find(
        (z) => z.name === host.split(".").slice(-2).join("."),
      );
      if (dnsTarget && zone) createServiceRecord(dnsTarget, zone, host);
      createIngressRoute(provider, "syncthing", host, nsName, traefikRelease);
    }
  }

  // --- Services + DNS records + ingress routes ---
  const services = Object.entries(conf.services)
    .filter(([, { hostname }]) => hostname && hostname.trim() !== "")
    .map(([name, { args, hostname }]) => {
      const service = createService(provider, name, args);

      if (dnsTarget) {
        const zoneName = hostname!.split(".").slice(-2).join(".");
        const zone = conf.zones.find((z) => z.name === zoneName);
        if (zone) {
          createServiceRecord(dnsTarget, zone, hostname!);
        }
      }

      createIngressRoute(provider, name, hostname!, nsName, traefikRelease);

      // Not marked secret, though some hostnames are encrypted in config:
      // hiding them is about the repository being public, and the state this
      // lands in is not. Marking them would only mean `--show-secrets` to read
      // an output back.
      return [name, { hostname, service: service.metadata.name }] as const;
    });

  // --- MCP Gateway: OAuth-fronted gateway for self-hosted MCP servers ---
  // Skipped unless configured and the GitHub OAuth app creds are present.
  if (
    conf.mcpGateway?.hostname &&
    conf.mcpGateway.authHostname &&
    conf.mcpGateway.github
  ) {
    const mg = conf.mcpGateway;
    createMcpGateway(provider, nsName, mg, {
      githubClientId: mg.github!.clientId,
      githubClientSecret: pulumi.secret(mg.github!.clientSecret),
      githubAllowed: mg.github!.allowed,
    });
    // Two public hostnames: the gateway and Hydra's public API. Admin stays
    // in-cluster (no ingress route).
    for (const [svcName, host] of [
      ["mcp-gateway", mg.hostname],
      ["mcp-gateway-hydra", mg.authHostname],
    ] as const) {
      if (dnsTarget) {
        const zone = conf.zones.find(
          (z) => z.name === host.split(".").slice(-2).join("."),
        );
        if (zone) createServiceRecord(dnsTarget, zone, host);
      }
      createIngressRoute(provider, svcName, host, nsName, traefikRelease);
    }
  }

  // --- sing-box client profiles, served from the cluster ---
  // Pulumi already holds every profile as a string, so the old round trip
  // through a file server on the home box bought nothing and cost an SSH write
  // to a machine that is being retired. Here the routing table is the content:
  // a rotated slug stops existing rather than lingering as a stale file.
  //
  // The primary is a node too: clients connect by IP, and its REALITY decoy is
  // its own reverse-proxied site (unlike edges, which use an external one). It
  // leads the list because buildProfile detours exits through nodes[0], the
  // host whose loopback the exits are bound to.
  const nodes: SingboxNode[] = [
    ...(gatewayIp && reality && hysteria
      ? [{ name: "primary", server: gatewayIp, hysteria, reality }]
      : []),
    ...edgeNodes,
  ];

  if (conf.profiles && nodes.length > 0 && conf.tailnet.magicdnsSuffix) {
    // Generated rather than carried as a secret, and rotated by the same value
    // that reissues every other VPN credential. It was the one credential
    // outside that mechanism — a separate thing to hold, in a separate place,
    // that had to be changed by hand to move the URLs.
    const singboxSlug = new random.RandomString(
      "singbox-slug",
      {
        length: 32,
        special: false,
        upper: false,
        keepers: { rotation: gatewayConf?.credentialRotation ?? "1" },
      },
      { additionalSecretOutputs: ["result"] },
    );

    createProfileServer(provider, nsName, users, nodes, {
      slug: singboxSlug.result,
      magicdnsSuffix: conf.tailnet.magicdnsSuffix,
      image: conf.profiles.image,
      exits,
      hostname: conf.profiles.hostname,
      telegram: conf.profiles.telegram
        ? {
            botToken: pulumi.secret(conf.profiles.telegram.botToken),
            chatId: conf.profiles.telegram.chatId,
          }
        : undefined,
    });

    const host = conf.profiles.hostname;
    const zone = conf.zones.find(
      (z) => z.name === host.split(".").slice(-2).join("."),
    );
    if (dnsTarget && zone) {
      createServiceRecord(dnsTarget, zone, host);
    }
    createIngressRoute(
      provider,
      "singbox-profiles",
      host,
      nsName,
      traefikRelease,
    );
  }

  return {
    ...(gatewayProvider && { gatewayProvider }),
    namespace,
    services: Object.fromEntries(services),
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
