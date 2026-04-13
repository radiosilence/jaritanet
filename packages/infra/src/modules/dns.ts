import * as cloudflare from "@pulumi/cloudflare";
import type * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type {
  BlueskyConfSchema,
  FastmailConfSchema,
  ZoneConfSchema,
} from "../conf.schemas.ts";

/**
 * Creates an A record pointing a service hostname at the gateway VPS IP.
 * Unlike the old tunnel setup, these are plain A records with proxied: false
 * — the server handles TLS itself via Traefik.
 */
export function createServiceRecord(
  vpsIp: pulumi.Output<string>,
  zone: z.infer<typeof ZoneConfSchema>,
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
  zone: z.infer<typeof ZoneConfSchema>,
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
  zone: z.infer<typeof ZoneConfSchema>,
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
