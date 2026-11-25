import * as cloudflare from "@pulumi/cloudflare";
import type * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type {
  BlueskyConfSchema,
  FastmailConfSchema,
  ZonesConfSchema,
} from "./dns.schemas.ts";

/** A zone as the records need it: with its id, known or still being looked up. */
export type Zone = {
  name: string;
  modules: z.infer<typeof ZonesConfSchema>[number]["modules"];
  zoneId: pulumi.Input<string>;
};

/**
 * Gives every zone an id, looking up by name in the account any zone configured
 * without one. A domain registered through Cloudflare already has its zone, so
 * its id need not be copied out of the dashboard first. The lookup only reads:
 * a name with no zone in the account fails the program rather than creating
 * one.
 */
export function resolveZones(
  zones: z.infer<typeof ZonesConfSchema>,
  accountId: string,
): Zone[] {
  return zones.map((zone) => ({
    ...zone,
    zoneId:
      zone.zoneId ??
      cloudflare.getZoneOutput({
        filter: { name: zone.name, account: { id: accountId } },
      }).id,
  }));
}

/**
 * Creates an A record pointing a service hostname at the gateway VPS IP.
 * Unlike the old tunnel setup, these are plain A records with proxied: false
 * — the server handles TLS itself via Traefik. `proxied` is for the one name a
 * CDN is meant to front (the XHTTP entry), where putting Cloudflare's edge in
 * front of the origin is the point.
 */
export function createServiceRecord(
  vpsIp: pulumi.Output<string>,
  zone: Zone,
  hostname: string,
  proxied = false,
) {
  const parts = hostname.split(".");
  const name = parts.length === 2 ? "@" : parts.slice(0, -2).join(".");

  return new cloudflare.DnsRecord(`${hostname}-a-record`, {
    content: vpsIp,
    name,
    proxied,
    ttl: 1,
    type: "A",
    zoneId: zone.zoneId,
  });
}

/**
 * Cloudflare's edge addresses. A request from one of them came through the
 * CDN, so the `X-Forwarded-For` it carries names the real client.
 */
export function cloudflareRanges() {
  return cloudflare
    .getIpRangesOutput()
    .apply((r) => [...r.ipv4Cidrs, ...r.ipv6Cidrs]);
}

/**
 * Caches a proxied hostname at Cloudflare's edge for as long as the origin's
 * `Cache-Control` allows a shared cache to, and passes through anything
 * without one, so the origin alone decides what is cached. The zone verifies
 * the origin's certificate (Traefik's, from Let's Encrypt) rather than
 * Cloudflare's default of accepting any, or none.
 *
 * Smart Tiered Cache sends an edge's miss to an upper-tier location rather
 * than the origin, so a link fetched worldwide costs the origin a few
 * requests instead of one per location.
 *
 * Cache rules are one ruleset per zone, so this owns the zone's.
 */
export function createCdnCache(zone: Zone, hostname: string) {
  new cloudflare.ZoneSetting(`${zone.name}-ssl`, {
    zoneId: zone.zoneId,
    settingId: "ssl",
    value: "strict",
  });
  new cloudflare.TieredCache(`${zone.name}-tiered-cache`, {
    zoneId: zone.zoneId,
    value: "on",
  });
  new cloudflare.Ruleset(`${zone.name}-cache`, {
    zoneId: zone.zoneId,
    name: "cache",
    kind: "zone",
    phase: "http_request_cache_settings",
    rules: [
      {
        description: `${hostname}: cache as the origin says`,
        expression: `(http.host eq "${hostname}")`,
        action: "set_cache_settings",
        actionParameters: {
          cache: true,
          edgeTtl: { mode: "bypass_by_default" },
          browserTtl: { mode: "respect_origin" },
        },
      },
    ],
  });
}

/**
 * Fastmail DNS records — MX, DKIM, SPF, DMARC.
 */
export function createFastmailRecords(
  zone: Zone,
  fastmail: z.infer<typeof FastmailConfSchema>,
) {
  for (const [key, value] of Object.entries({ in1: 10, in2: 20 })) {
    new cloudflare.DnsRecord(`${zone.name}-fm-mx-${key}`, {
      content: `${key}.${fastmail.mxDomain}`,
      name: zone.name,
      priority: value,
      ttl: 1,
      type: "MX",
      zoneId: zone.zoneId,
    });
  }

  for (const key of ["fm1", "fm2", "fm3", "fm4"]) {
    new cloudflare.DnsRecord(`${zone.name}-fm-dkim-${key}`, {
      content: `${key}.${zone.name}.${fastmail.dkimDomain}`,
      name: `${key}.${fastmail.dkimSubdomain}`,
      proxied: false,
      ttl: 1,
      type: "CNAME",
      zoneId: zone.zoneId,
    });
  }

  new cloudflare.DnsRecord(`${zone.name}-fm-spf`, {
    content: `"v=spf1 include:${fastmail.spfDomain} ?all"`,
    name: zone.name,
    ttl: 1,
    type: "TXT",
    zoneId: zone.zoneId,
  });

  new cloudflare.DnsRecord(`${zone.name}-fm-dmarc`, {
    content: `"v=DMARC1; p=${fastmail.dmarcPolicy}; rua=mailto:${fastmail.dmarcAggEmail}"`,
    name: fastmail.dmarcSubdomain,
    ttl: 1,
    type: "TXT",
    zoneId: zone.zoneId,
  });
}

/**
 * Bluesky ATProto DID verification record.
 */
export function createBlueskyRecords(
  zone: Zone,
  bluesky: z.infer<typeof BlueskyConfSchema>,
) {
  new cloudflare.DnsRecord(`${zone.name}-bs-did`, {
    content: `"did=${bluesky.did}"`,
    name: "_atproto",
    ttl: 1,
    type: "TXT",
    zoneId: zone.zoneId,
  });
}
