import {
  createBlueskyRecords,
  createFastmailRecords,
  createServiceRecord,
} from "@jaritanet/dns";
import { createCilium } from "@jaritanet/hetzner";
import {
  createIngress,
  createIngressRoute,
  createIpWatcher,
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
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import { conf } from "./conf.ts";
import { GatewayConfSchema } from "./conf.schemas.ts";
import { createEdge } from "./edge.ts";
import { env, vpnUsers } from "./env.ts";
import { createGateway } from "./gateway.ts";
import { createTailnetPolicy } from "./tailnet-policy.ts";

export default async function () {
  const { namespace } = conf;
  let dnsTarget: pulumi.Output<string> | undefined;
  let ratholeToken: pulumi.Output<string> | undefined;
  let gatewayProvider: string | undefined;
  // Set when the gateway runs its own control plane; its kubeconfig then
  // replaces the KUBE_* secrets below.
  let gatewayK3s: ReturnType<typeof createGateway>["k3s"];
  let gatewayConf: z.infer<typeof GatewayConfSchema> | undefined;
  let gatewayIp: pulumi.Output<string> | undefined;
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
  // are known — buildProfile treats nodes[0] as the rathole node that exits
  // detour through, so the order is load-bearing.
  const edgeNodes: SingboxNode[] = [];

  // The VPN roster. No VPN_USERS → a single implicit owner-admin, so the
  // multi-user path is exercised uniformly and old single-owner deploys keep
  // full access. A trailing `+` in the secret marks an admin; the rest are guests.
  const users: VpnUser[] =
    vpnUsers.length > 0 ? vpnUsers : [{ name: "owner", role: "admin" }];

  // Resolve each exit's loopback port once (derived from the name unless set),
  // so the identical port is used at the gateway bind, ss server, rathole
  // client, and client outbound. Assert uniqueness — a clash means the user
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

  if (env.HCLOUD_TOKEN) {
    gatewayConf = conf.gateway ?? GatewayConfSchema.parse({});
    // Exits surface on the gateway's rathole loopback (name + port).
    const gw = createGateway(gatewayConf, users, resolvedExits, {
      entryLabel: env.VPN_ENTRY_LABEL,
      magicdnsSuffix: env.TAILNET_MAGICDNS_SUFFIX,
      tailnetAuthKey: env.TS_AUTHKEY,
    });
    dnsTarget = gw.vpsIp;
    gatewayIp = gw.vpsIp;
    ratholeToken = gw.ratholeToken.result;
    gatewayProvider = "hetzner";
    gatewayK3s = gw.k3s;
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
    // picker entry. Tailnet relay only when TS_AUTHKEY is present.
    const edgeAuthKey = env.TS_AUTHKEY
      ? pulumi.secret(env.TS_AUTHKEY)
      : undefined;
    for (const edge of conf.edges) {
      const e = createEdge(edge, users, edgeAuthKey);
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
  } else if (conf.externalIp) {
    dnsTarget = pulumi.output(conf.externalIp);
  }

  // Tailnet policy as code — only once an OAuth client exists, so this is a
  // no-op until the secrets are set (and even then the provider refuses to
  // touch a policy nobody has imported).
  if (env.TS_OAUTH_CLIENT_ID && env.TS_OAUTH_CLIENT_SECRET && env.TS_TAILNET) {
    createTailnetPolicy(
      pulumi.secret(env.TS_OAUTH_CLIENT_ID),
      pulumi.secret(env.TS_OAUTH_CLIENT_SECRET),
      env.TS_TAILNET,
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
  //
  // Replaces a hand-built kubeconfig pointing at microk8s on the home box,
  // which reached it with a service-account token ansible pushed into GitHub
  // secrets and trusted whatever certificate it was handed.
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
    gatewayK3s && gatewayConf?.k3s
      ? createCilium(provider, gatewayConf.k3s.ciliumVersion, [
          gatewayK3s.install,
        ])
      : undefined;

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

  // Egress exit nodes: ss-rust in-cluster. The rathole client (in createIngress)
  // punches each one's port out to the gateway loopback.
  const exits = resolvedExits.map((e) => createExit(provider, nsName, e));

  // --- Ingress: Traefik, plus a rathole client only when the cluster is
  // somewhere other than the gateway. Co-located, rathole would tunnel a box to
  // itself: xray relays straight to Traefik's hostPort instead.
  const clusterOnGateway = Boolean(gatewayK3s);
  const { traefikRelease } = createIngress(
    provider,
    nsName,
    conf.traefik,
    clusterOnGateway ? undefined : dnsTarget,
    clusterOnGateway ? undefined : ratholeToken,
    env.CLOUDFLARE_API_TOKEN,
    resolvedExits,
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
  if (clusterOnGateway && gatewayConf) {
    createUnbound(
      provider,
      nsName,
      gatewayConf.unbound,
      env.VPN_ENTRY_LABEL,
      transportDeps,
    );

    if (gatewayConf.tailnet && env.TS_AUTHKEY) {
      createTailscale(
        provider,
        nsName,
        gatewayConf.tailnet,
        pulumi.secret(env.TS_AUTHKEY),
        env.VPN_ENTRY_LABEL,
        transportDeps,
      );
    }

    if (gatewayConf.xray) {
      const t = createXray(
        provider,
        nsName,
        gatewayConf.xray,
        users,
        env.VPN_ENTRY_LABEL,
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
        env.VPN_ENTRY_LABEL,
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

  // IP watcher — triggers deploy when external IP changes
  if (env.DEPLOY_TOKEN) {
    createIpWatcher(provider, nsName, env.DEPLOY_TOKEN, env.GITHUB_REPOSITORY);
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

      return [name, { hostname, service: service.metadata.name }] as const;
    });

  // --- MCP Gateway: OAuth-fronted gateway for self-hosted MCP servers ---
  // Skipped unless configured and the GitHub OAuth app creds are present.
  if (
    conf.mcpGateway?.hostname &&
    conf.mcpGateway.authHostname &&
    env.GH_CLIENT_ID &&
    env.GH_CLIENT_SECRET
  ) {
    const mg = conf.mcpGateway;
    createMcpGateway(provider, nsName, mg, {
      githubClientId: env.GH_CLIENT_ID,
      githubClientSecret: pulumi.secret(env.GH_CLIENT_SECRET),
      githubAllowed: env.GH_ALLOWED ?? "",
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
  // only node running rathole.
  const nodes: SingboxNode[] = [
    ...(gatewayIp && reality && hysteria
      ? [{ name: "primary", server: gatewayIp, hysteria, reality }]
      : []),
    ...edgeNodes,
  ];

  if (
    conf.profiles &&
    nodes.length > 0 &&
    env.SINGBOX_SLUG &&
    env.TAILNET_MAGICDNS_SUFFIX
  ) {
    createProfileServer(provider, nsName, users, nodes, {
      slug: env.SINGBOX_SLUG,
      magicdnsSuffix: env.TAILNET_MAGICDNS_SUFFIX,
      image: conf.profiles.image,
      exits,
      hostname: conf.profiles.hostname,
      telegram:
        env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ? {
              botToken: pulumi.secret(env.TELEGRAM_BOT_TOKEN),
              chatId: env.TELEGRAM_CHAT_ID,
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
