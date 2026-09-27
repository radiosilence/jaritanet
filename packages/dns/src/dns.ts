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
 * — the server handles TLS itself via Traefik.
 */
export function createServiceRecord(
  vpsIp: pulumi.Output<string>,
  zone: Zone,
  hostname: string,
) {
  const parts = hostname.split(".");
  const name = parts.length === 2 ? "@" : parts.slice(0, -2).join(".");

  return new cloudflare.DnsRecord(`${hostname}-a-record`, {
    content: vpsIp,
    name,
    proxied: false,
    ttl: 1,
    type: "A",
    zoneId: zone.zoneId,
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
