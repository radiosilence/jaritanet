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
import { createMcpGateway } from "@jaritanet/mcp-gateway";
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
  /** Rotates the profile slug along with every other VPN credential. */
  credentialRotation: string;
  exits: Exit[];
  magicdnsSuffix?: string;
  /** Entry nodes for the client profile — the gateway, then every edge. */
  singboxNodes: SingboxNode[];
  users: VpnUser[];
};

/**
 * A hostname to publish, and the workload answering it.
 *
 * `service` is the prefix, not the object's name — `createService` names its
 * Service `<prefix>-service` and `createIngressRoute` derives the same backend
 * from the same prefix, so a route names the pair rather than either half.
 */
type Route = { service: string; hostname: string };

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
      if (!service.github || !service.hostname || !service.authHostname)
        return [];
      createMcpGateway(provider, namespace, service, {
        githubClientId: service.github.clientId,
        githubClientSecret: pulumi.secret(service.github.clientSecret),
        githubAllowed: service.github.allowed,
      });
      // Two public hostnames: the gateway and Hydra's public API. Admin stays
      // in-cluster, with no route at all.
      return [
        { service: "mcp-gateway", hostname: service.hostname },
        { service: "mcp-gateway-hydra", hostname: service.authHostname },
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
        image: service.image,
        exits: ctx.exits,
        hostname: service.hostname,
        telegram: service.telegram
          ? {
              botToken: pulumi.secret(service.telegram.botToken),
              chatId: service.telegram.chatId,
            }
          : undefined,
      });
      return [{ service: "singbox-profiles", hostname: service.hostname }];
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
  const published: Record<string, { hostname: string; service: string }> = {};

  for (const [name, service] of Object.entries(services)) {
    for (const route of createOne(ctx, name, service)) {
      // Zones are two labels here, which is what makes this work. A zone with
      // three (`example.co.uk`) would be looked up as `co.uk`, find nothing and
      // silently skip the record — createServiceRecord splits the same way when
      // it derives the record's own name, so fixing one half alone would only
      // move the disagreement.
      const zone = ctx.zones.find(
        (z) => z.name === route.hostname.split(".").slice(-2).join("."),
      );
      if (ctx.dnsTarget && zone) {
        createServiceRecord(ctx.dnsTarget, zone, route.hostname);
      }
      createIngressRoute(
        ctx.provider,
        route.service,
        route.hostname,
        ctx.namespace,
        ctx.traefik,
      );
      published[route.service] = {
        hostname: route.hostname,
        service: `${route.service}-service`,
      };
    }
  }

  return published;
}
