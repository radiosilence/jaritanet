/**
 * Everything this deployment runs in the cluster, said once, in TypeScript.
 *
 * This replaced a `services` map in the stack config dispatched through a
 * `kind` union. That union existed only so data could pick a constructor —
 * which is what a program does by calling one. With the data gone the union,
 * its switch, and the per-kind knowledge the stack had to hold about each
 * service (which callback path Grafana wants, which kinds take a hostname) go
 * with it: a service is now a function call, and what it needs is its
 * arguments.
 *
 * What every service still shares — an address, and possibly an OAuth client —
 * is handled once, here, from what each constructor returns. That is the part
 * that must not be hand-rolled per service: the redirect allowlist is what
 * stands between the provider and an open redirect, and deriving it from the
 * hostname the service was published at means it cannot hold a typo or keep an
 * entry for a service that moved.
 */
import type { RelyingParty } from "@jaritanet/auth";
import { createBlit } from "@jaritanet/blit";
import { createServiceRecord } from "@jaritanet/dns";
import { createFiles } from "@jaritanet/files";
import { createSamba, createSyncthing } from "@jaritanet/home";
import { createIngressRoute } from "@jaritanet/ingress";
import { type Deployed, resourceRequests, type Route } from "@jaritanet/k8s";
import { createMariastew } from "@jaritanet/mariastew";
import { createMcpGateway } from "@radiosilence/mcp-gateway-pulumi";
import { createMetrics, GRAFANA } from "@jaritanet/metrics";
import { createNavidrome } from "@jaritanet/navidrome";
import {
  createProfileServer,
  type Exit,
  type SingboxNode,
  type VpnUser,
} from "@jaritanet/vpn";
import type * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { ZonesConfSchema } from "./schemas.ts";
import { MCPS } from "./mcps.ts";

/**
 * The machine holding the media drive.
 *
 * A hostname rather than a label because it pins a `local` PersistentVolume's
 * node affinity, which names a node. The daemonset-shaped file services select
 * `FILE_NODE_LABEL` instead — which machine holds the disks is a property of
 * that machine, applied by the seed drive when it joins.
 */
const MEDIA_NODE = "lady";

/** One binding, because the requests below are derived from it. */
const MCP_GATEWAY_LIMITS = { cpu: "250m", memory: "256Mi" };
const FILE_NODE_LABEL = "jaritanet.radiosilence.dev/file-node";

/**
 * What the stack has already built by the time services are created.
 *
 * Wider than most services need, because the VPN profile server needs all of
 * it — it renders every user's credentials for every entry and exit, so it
 * cannot be constructed before the transports it describes.
 */
export type EstateContext = {
  provider: k8s.Provider;
  namespace: pulumi.Input<string>;
  zones: z.infer<typeof ZonesConfSchema>;
  /** Where each service is published. A name with no entry is not published. */
  hostnames: Record<string, string>;
  /** Where A records point. Absent → no gateway, so no records are created. */
  dnsTarget?: pulumi.Output<string>;
  /** IngressRoute is a CRD the Traefik chart brings; routes wait on it. */
  traefik?: pulumi.Resource;
  /**
   * Where the authorization server stands. Absent → nothing that depends on
   * being able to authenticate is deployed.
   */
  authHostname?: string;
  /** Rotates the profile slug along with every other VPN credential. */
  credentialRotation: string;
  exits: Exit[];
  magicdnsSuffix?: string;
  /** Entry nodes for the client profile — the gateway, then every edge. */
  singboxNodes: SingboxNode[];
  users: VpnUser[];
  /** Shared bot: the profile server and mariastew both notify through it. */
  telegram?: { botToken: string; chatId: string };
};

/**
 * One secret per relying party, generated where both halves can be handed the
 * same value — the provider registers the client with it, the service
 * authenticates with it, and neither mints its own.
 *
 * Named `<client>-oidc` because that is the name mariastew's own generator
 * used, so lifting it out here rewired who owns the credential without rotating
 * it. The name is the URN; changing it logs everybody out.
 *
 * NB: random.* resources use the default provider — passing the k8s provider
 * makes Pulumi look for `random:...` types on it and fail with "unrecognized
 * resource type".
 */
const oidcSecret = (id: string) =>
  new random.RandomPassword(`${id}-oidc`, { length: 48, special: false })
    .result;

/**
 * A service's OAuth client, paired with the secret it was handed.
 *
 * Throws rather than skipping when a service asked to be registered and nothing
 * came with it. Skipping is the worse failure: the service deploys, publishes,
 * and cannot log anybody in, with nothing anywhere reporting a fault — which is
 * exactly the shape of bug that a `kind` switch quietly falling through used to
 * produce.
 */
export function registration(d: Deployed, secret?: pulumi.Input<string>) {
  if (!d.oidc) return undefined;
  if (secret === undefined) {
    throw new Error(
      `${d.oidc.id} returned an OAuth client but was handed no secret`,
    );
  }
  return { ...d.oidc, secret };
}

/**
 * The zone a hostname belongs to, or undefined.
 *
 * Two labels, which is what makes this work here and would not elsewhere: a
 * zone with three (`example.co.uk`) is looked up as `co.uk`, finds nothing and
 * silently skips the record. `createServiceRecord` splits the same way when it
 * derives the record's own name, so fixing one half alone would only move the
 * disagreement.
 */
export function zoneFor(
  zones: z.infer<typeof ZonesConfSchema>,
  hostname: string,
) {
  return zones.find(
    (zone) => zone.name === hostname.split(".").slice(-2).join("."),
  );
}

export function createServices(ctx: EstateContext) {
  const { provider, hostnames } = ctx;
  const ns = ctx.namespace;
  const routes: Route[] = [];
  const clients: RelyingParty[] = [];

  /** Collect what a service published and what it needs registered. */
  const add = (d: Deployed, secret?: pulumi.Output<string>) => {
    routes.push(...d.routes);
    const client = registration(d, secret);
    if (client) clients.push(client);
  };

  // --- The box that holds the disks ----------------------------------------
  add(
    createNavidrome(provider, "navidrome", {
      hostname: hostnames.navidrome,
      node: MEDIA_NODE,
    }),
  );
  add(
    createFiles(provider, "files", {
      hostname: hostnames.files,
      node: MEDIA_NODE,
    }),
  );
  add(createBlit(provider, "blit", { hostname: hostnames.blit }));

  // What lady serves off the media drive. Shares are anonymous — `map to guest`
  // turns unknown users into `guestAccount`, which must own the files or every
  // read fails — and reachable only from the tailnet and the LAN, never the
  // internet. jc owns /mnt/kontent, and is uid/gid 1000 on the node.
  //
  // Paths are under the mount, so an unmounted drive means the hostPath type
  // `Directory` finds nothing and the pod stays Pending rather than serving an
  // empty share.
  //
  // No hostname: SMB is not HTTP, and the share is reached on the node's own
  // interfaces.
  createSamba(
    provider,
    ns,
    {
      guestAccount: "jc",
      shares: [
        { name: "music", hostPath: "/mnt/kontent/music" },
        { name: "movies", hostPath: "/mnt/kontent/movies" },
        { name: "tv", hostPath: "/mnt/kontent/tv" },
        { name: "dl", hostPath: "/mnt/kontent/dl" },
      ],
    },
    FILE_NODE_LABEL,
  );

  // Which folders syncthing can reach; what is actually synced with whom is set
  // in its own UI, which is state it keeps for itself. Not published, so the UI
  // stays on :8384 over the LAN and the tailnet.
  //
  // It runs as the media's owner rather than relying on fsGroup, which kubelet
  // does not apply to hostPath volumes — so what it writes stays readable by
  // samba and navidrome.
  createSyncthing(
    provider,
    ns,
    { folders: [{ name: "music", hostPath: "/mnt/kontent/music" }] },
    FILE_NODE_LABEL,
  );

  // --- The MCP gateway ------------------------------------------------------
  // No identity provider, no gateway: the dashboard signs people in through it,
  // and one that cannot would front every backend with no way to say who is
  // asking.
  if (hostnames["mcp-gateway"] && ctx.authHostname) {
    const secret = oidcSecret("mcp-gateway");
    add(
      createMcpGateway(
        provider,
        ns,
        {
          replicas: 2,
          // Routes and terminates OAuth rather than serving a file, so more
          // headroom than blit — but it measured 1m CPU idle, not 500m.
          limits: MCP_GATEWAY_LIMITS,
          // The chart takes the numbers and states no policy about them: how
          // much of a ceiling to reserve depends on what else shares the node,
          // which is ours to know. See `resourceRequests`.
          requests: resourceRequests(MCP_GATEWAY_LIMITS).requests,
          mcps: MCPS,
        },
        {
          hostname: hostnames["mcp-gateway"],
          oidcClientId: "mcp-gateway",
          oidcClientSecret: secret,
          authHostname: ctx.authHostname,
        },
      ),
      secret,
    );
    // Hydra's public API shares the identity provider's hostname, split by
    // path: this claims the bare host and the provider claims the specific
    // paths within it. Admin stays in-cluster, with no route at all.
    routes.push({
      service: "mcp-gateway-hydra",
      hostname: ctx.authHostname,
    });
  }

  // --- mariastew ------------------------------------------------------------
  // A write endpoint onto the media library is not published without a way to
  // authenticate, so an unconfigured one is not deployed rather than deployed
  // open.
  if (hostnames.mariastew && ctx.authHostname) {
    const secret = oidcSecret("mariastew");
    add(
      createMariastew(
        provider,
        ns,
        {
          // Television and film only, which is what makes the scene-garbage
          // filter global — there is no album art to protect, so one list
          // serves every download. Each root is both the pod's mount and a
          // root the picker browses, declared once.
          roots: [
            { name: "tv", hostPath: "/mnt/kontent/tv" },
            { name: "movies", hostPath: "/mnt/kontent/movies" },
          ],
        },
        {
          hostname: hostnames.mariastew,
          nodeLabel: FILE_NODE_LABEL,
          oidcClientSecret: secret,
          oidc: {
            issuer: `https://${ctx.authHostname}`,
            clientId: "mariastew",
          },
          telegram: ctx.telegram
            ? {
                botToken: pulumi.secret(ctx.telegram.botToken),
                chatId: ctx.telegram.chatId,
              }
            : undefined,
        },
      ),
      secret,
    );
  }

  // --- Metrics --------------------------------------------------------------
  // There was no history of anything: k3s ships metrics-server, so `kubectl
  // top` answers with fifteen seconds of instantaneous CPU, no retention and no
  // disk IO at all. #166/#168 were diagnosed by guessing at resource ceilings
  // nobody had measured.
  //
  // The store and Grafana's own state are directories on the gateway, so both
  // pin there — the home box is exactly where the dashboard must not live,
  // since its uplink dropping is when the graphs are most wanted.
  {
    const metricsConf = {
      storageNode: "sympathy",
      vmsingle: {
        // Order of 10k series across both nodes with cAdvisor included, at a
        // 30s scrape, is single-digit GB a year on VictoriaMetrics'
        // compression.
        retention: "1y",
      },
    };
    if (hostnames.metrics && ctx.authHostname) {
      const secret = oidcSecret("metrics");
      createMetrics(provider, ns, metricsConf, {
        hostname: hostnames.metrics,
        authHostname: ctx.authHostname,
        clientId: "metrics",
        clientSecret: secret,
      });
      routes.push({ service: GRAFANA, hostname: hostnames.metrics });
      clients.push({
        id: "metrics",
        name: "metrics",
        // Grafana's callback path is fixed by Grafana, not by us.
        redirectUri: `https://${hostnames.metrics}/login/generic_oauth`,
        secret,
      });
    } else {
      createMetrics(provider, ns, metricsConf);
    }
  }

  // --- The sing-box subscription server -------------------------------------
  // Nothing to serve without entries to describe, and no way to address the
  // exits without MagicDNS. Both are the state during a rebuild, so this is
  // skipped rather than fatal — a profile server holding no profiles is worse
  // than one that is not there.
  //
  // Deliberately not on blit.cc: FortiGuard rates it "Other Adult Materials",
  // so a filtered network — exactly the network a VPN profile is wanted on —
  // blocks the device from fetching its own subscription.
  const profileHost = hostnames["singbox-profiles"];
  if (profileHost && ctx.singboxNodes.length && ctx.magicdnsSuffix) {
    // Generated rather than carried as a secret, and rotated by the same value
    // that reissues every other VPN credential. It was the one credential
    // outside that mechanism — a separate thing to hold, in a separate place,
    // that had to be changed by hand to move the URLs.
    const slug = new random.RandomString(
      "singbox-slug",
      {
        length: 32,
        special: false,
        upper: false,
        keepers: { rotation: ctx.credentialRotation },
      },
      { additionalSecretOutputs: ["result"] },
    );
    createProfileServer(provider, ns, ctx.users, ctx.singboxNodes, {
      slug: slug.result,
      magicdnsSuffix: ctx.magicdnsSuffix,
      exits: ctx.exits,
      hostname: profileHost,
      telegram: ctx.telegram
        ? {
            botToken: pulumi.secret(ctx.telegram.botToken),
            chatId: ctx.telegram.chatId,
          }
        : undefined,
    });
    routes.push({ service: "singbox-profiles", hostname: profileHost });
  }

  return { routes, clients };
}

/**
 * Give a set of routes an A record and an IngressRoute, and report them.
 *
 * Takes every route the stack has in one call rather than one call per source:
 * a hostname can be answered by two workloads — the identity provider shares
 * Hydra's, split by path — and an A record is per hostname where an
 * IngressRoute is per route. Two calls made the record twice, and Pulumi
 * refused the duplicate URN.
 */
export function publishRoutes(ctx: EstateContext, routes: Route[]) {
  const published: Record<string, { hostname: string; service: string }> = {};
  const recorded = new Set<string>();

  for (const route of routes) {
    const zone = zoneFor(ctx.zones, route.hostname);
    if (ctx.dnsTarget && zone && !recorded.has(route.hostname)) {
      recorded.add(route.hostname);
      createServiceRecord(ctx.dnsTarget, zone, route.hostname);
    }
    createIngressRoute(
      ctx.provider,
      route.service,
      route.hostname,
      ctx.namespace,
      ctx.traefik,
      { paths: route.paths, priority: route.priority },
    );
    published[route.service] = {
      hostname: route.hostname,
      service: `${route.service}-service`,
    };
  }

  return published;
}
