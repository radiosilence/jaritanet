/**
 * Everything this deployment runs in the cluster, from one loop.
 *
 * A service declares its `kind`; the kind decides which constructor runs and
 * what shape its config has. What every kind shares — being published at a
 * hostname — is handled here, once. That replaced four hand-rolled copies of
 * "split the hostname, find the zone, make an A record, make an IngressRoute",
 * which had drifted into four slightly different zone lookups guarding four
 * slightly different sets of conditions.
 *
 * The `switch` is deliberate rather than a registry of constructors keyed by
 * kind: Zod's discriminated union narrows a `switch` to the exact member type,
 * and a lookup table would need a cast at every entry to get the same thing.
 */
import { createServiceRecord } from "@jaritanet/dns";
import { createSamba, createSyncthing } from "@jaritanet/home";
import { createIngressRoute } from "@jaritanet/ingress";
import { createService } from "@jaritanet/k8s";
import { createMariastew } from "@jaritanet/mariastew";
import { createMcpGateway } from "@jaritanet/mcp-gateway";
import { createMetrics, GRAFANA } from "@jaritanet/metrics";
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
import type { ServiceConfSchema, ZonesConfSchema } from "./conf.schemas.ts";

/**
 * What the stack has already built by the time services are created.
 *
 * Wider than most kinds need, because the VPN profile server needs all of it —
 * it renders every user's credentials for every entry and exit, so it cannot be
 * constructed before the transports it describes. Passing one context rather
 * than threading six arguments through a `switch` is what keeps the ordering
 * honest: a kind that reads nothing from here has no ordering constraint, and
 * that is visible at its `case`.
 */
export type ServiceContext = {
  provider: k8s.Provider;
  namespace: pulumi.Input<string>;
  zones: z.infer<typeof ZonesConfSchema>;
  /** Where A records point. Absent → no gateway, so no records are created. */
  dnsTarget?: pulumi.Output<string>;
  /** IngressRoute is a CRD the Traefik chart brings; routes wait on it. */
  traefik?: pulumi.Resource;
  /**
   * Where the authorization server stands and the identity provider answers.
   * Read once at the top level and handed to everything that needs it, so two
   * readers cannot disagree about it — the shape `vpnEntryLabel` uses. Absent
   * → nothing that depends on being able to authenticate is deployed.
   */
  authHostname?: string;
  /**
   * Each relying party's client secret, keyed by client id, generated once by
   * the stack and handed to both halves — the provider registers the client
   * with it, the service authenticates with it. Neither mints its own, which
   * is what stops the two from disagreeing.
   */
  oidcClientSecrets: Record<string, pulumi.Output<string>>;
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
 * A hostname to publish, and the workload answering it.
 *
 * `service` is the prefix, not the object's name — `createService` names its
 * Service `<prefix>-service` and `createIngressRoute` derives the same backend
 * from the same prefix, so a route names the pair rather than either half.
 */
export type Route = {
  service: string;
  hostname: string;
  /**
   * Only for the hostname two workloads share. Absent means the whole host,
   * which is what everything else wants — see `routeMatch`.
   */
  paths?: string[];
  priority?: number;
};

/**
 * The services that need to sign people in, and where each is sent back to.
 *
 * Everything about the registration is derived, and that is the security
 * control rather than tidiness: the redirect allowlist is what stands between
 * the provider and an open redirect, so a list generated from the hostname a
 * service already publishes cannot hold a typo, cannot keep an entry for a
 * service that moved, and gives no service a way to widen its own permissions.
 *
 * The client id is the service's own name, so it is not a second thing to
 * choose and cannot disagree with anything. The callback *path* is per kind
 * because Grafana's is fixed by Grafana — `/login/generic_oauth`, not the
 * `/auth/callback` the two services written here implement. What stays derived
 * is the part that matters: the host half comes from the hostname the service
 * already publishes, so no service can name where it is sent back to.
 *
 * The kinds are named rather than looked up in a set, for the reason the
 * `switch` in `createOne` exists: comparing the discriminant narrows the union,
 * and `Set.has` does not, so a set would need a cast to read `hostname`.
 */
export function relyingParties(
  services: Record<string, z.infer<typeof ServiceConfSchema>>,
) {
  return Object.entries(services).flatMap(([name, service]) => {
    const redirectUri =
      service.kind === "mariastew" || service.kind === "mcp-gateway"
        ? service.hostname && `https://${service.hostname}/auth/callback`
        : service.kind === "metrics"
          ? service.hostname &&
            `https://${service.hostname}/login/generic_oauth`
          : undefined;
    return redirectUri ? [{ id: name, name, redirectUri }] : [];
  });
}

function createOne(
  ctx: ServiceContext,
  name: string,
  service: z.infer<typeof ServiceConfSchema>,
): Route[] {
  const { provider, namespace } = ctx;

  switch (service.kind) {
    case "web":
      createService(provider, name, service.args);
      return service.hostname
        ? [{ service: name, hostname: service.hostname }]
        : [];

    case "samba":
      // No hostname: SMB is not HTTP, and the share is reached on the node's own
      // interfaces (see SambaConfSchema on why hostNetwork is the design).
      createSamba(provider, namespace, service, service.nodeLabel);
      return [];

    case "syncthing":
      createSyncthing(provider, namespace, service, service.nodeLabel);
      // The web UI only. Omit the hostname and it stays reachable on the LAN
      // and the tailnet at :8384, which is where it belongs by default.
      return service.hostname
        ? [{ service: "syncthing", hostname: service.hostname }]
        : [];

    case "mcp-gateway": {
      // No OAuth app, no gateway: it exists to authenticate people, and one
      // that cannot would front every backend unauthenticated.
      // No identity provider, no gateway: the dashboard signs people in
      // through it, and one that cannot would front every backend with no way
      // to say who is asking.
      if (!service.hostname || !ctx.authHostname) return [];
      createMcpGateway(provider, namespace, service, {
        oidcClientId: name,
        oidcClientSecret: ctx.oidcClientSecrets[name],
        authHostname: ctx.authHostname,
      });
      // Two public hostnames: the gateway and Hydra's public API, the latter
      // shared with the identity provider and split by path — so this claims
      // the bare host and the provider claims the specific paths within it.
      // Admin stays in-cluster, with no route at all.
      return [
        { service: "mcp-gateway", hostname: service.hostname },
        { service: "mcp-gateway-hydra", hostname: ctx.authHostname },
      ];
    }

    case "singbox-profiles": {
      // Nothing to serve without entries to describe, and no way to address the
      // exits without MagicDNS. Both are the state during a rebuild, so this is
      // skipped rather than fatal — a profile server holding no profiles is
      // worse than one that is not there.
      if (!ctx.singboxNodes.length || !ctx.magicdnsSuffix) return [];

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

      createProfileServer(provider, namespace, ctx.users, ctx.singboxNodes, {
        slug: slug.result,
        magicdnsSuffix: ctx.magicdnsSuffix,
        exits: ctx.exits,
        hostname: service.hostname,
        telegram: ctx.telegram
          ? {
              botToken: pulumi.secret(ctx.telegram.botToken),
              chatId: ctx.telegram.chatId,
            }
          : undefined,
      });
      return [{ service: "singbox-profiles", hostname: service.hostname }];
    }

    case "mariastew": {
      // A write endpoint onto the media library is not published without a
      // way to authenticate, so an unconfigured one is not deployed rather
      // than deployed open.
      if (!service.hostname || !ctx.authHostname) return [];
      createMariastew(provider, namespace, service, {
        nodeLabel: service.nodeLabel,
        oidcClientSecret: ctx.oidcClientSecrets[name],
        // Read once at the top level and handed down, so no service carries its
        // own copy of where identity lives.
        oidc: { issuer: `https://${ctx.authHostname}`, clientId: name },
        telegram: ctx.telegram
          ? {
              botToken: pulumi.secret(ctx.telegram.botToken),
              chatId: ctx.telegram.chatId,
            }
          : undefined,
      });
      return [{ service: "mariastew", hostname: service.hostname }];
    }

    case "metrics": {
      // The collection half stands either way: a store that is filling is
      // worth having even on a deploy that cannot publish a dashboard. Grafana
      // is the part that is skipped, because it has no local login form — one
      // deployed with nowhere to sign in is a page nobody can open.
      if (!service.hostname || !ctx.authHostname) {
        createMetrics(provider, namespace, service);
        return [];
      }
      createMetrics(provider, namespace, service, {
        authHostname: ctx.authHostname,
        clientId: name,
        clientSecret: ctx.oidcClientSecrets[name],
      });
      return [{ service: GRAFANA, hostname: service.hostname }];
    }
  }
}

/**
 * Build every service and publish the hostnames they claim.
 *
 * Returns the published set for the stack outputs. Hostnames are not marked
 * secret though some are encrypted in config: hiding them is about the
 * repository being public, and the state this lands in is not.
 */
export function createServices(
  ctx: ServiceContext,
  services: Record<string, z.infer<typeof ServiceConfSchema>>,
) {
  return Object.entries(services).flatMap(([name, service]) =>
    createOne(ctx, name, service),
  );
}

/**
 * Give a set of routes an A record and an IngressRoute, and report them.
 *
 * Takes every route the stack has in one call rather than one call per source:
 * a hostname can be answered by two workloads — the identity provider shares
 * Hydra's, split by path — and an A record is per hostname where an
 * IngressRoute is per route. Two calls made the record twice, and Pulumi
 * refused the duplicate URN.
 *
 * Separate from `createServices` because the identity provider is not a
 * service — it is the thing that authenticates for them, the way Traefik is the
 * thing that publishes them — but it still has an address, and publishing it by
 * hand would be the fifth copy of "split the hostname, find the zone, make an A
 * record, make an IngressRoute" that this function exists to have replaced.
 */
export function publishRoutes(ctx: ServiceContext, routes: Route[]) {
  const published: Record<string, { hostname: string; service: string }> = {};
  const recorded = new Set<string>();

  for (const route of routes) {
    // Zones are two labels here, which is what makes this work. A zone with
    // three (`example.co.uk`) would be looked up as `co.uk`, find nothing and
    // silently skip the record — createServiceRecord splits the same way when
    // it derives the record's own name, so fixing one half alone would only
    // move the disagreement.
    const zone = ctx.zones.find(
      (z) => z.name === route.hostname.split(".").slice(-2).join("."),
    );
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
