import * as cloudflare from "@pulumi/cloudflare";
import type * as z from "zod";
import type { ZoneConfSchema } from "../conf.schemas.ts";

/**
 * Fastmail DNS records, configured globally.
 *
 * @param zone - The zone to create the record in.
 * @param fastmailConfig - Optional fastmail config (will lazy load if not provided)
 */
import { conf } from "../conf.ts";

export function fastmail(zone: z.infer<typeof ZoneConfSchema>) {
  const {
    mxDomain,
    dkimDomain,
    dkimSubdomain,
    dmarcSubdomain,
    dmarcAggEmail,
    dmarcPolicy,
    spfDomain,
  } = conf.fastmail;

  for (const [key, value] of Object.entries({ in1: 10, in2: 20 })) {
    new cloudflare.DnsRecord(`${zone.name}-fm-mx-${key}`, {
      ...zone,
      priority: value,
      type: "MX",
      content: `${key}.${mxDomain}`,
      ttl: 1,
    });
  }

  for (const key of ["fm1", "fm2", "fm3", "fm4"]) {
    new cloudflare.DnsRecord(`${zone.name}-fm-dkim-${key}`, {
      ...zone,
      name: `${key}.${dkimSubdomain}`,
      proxied: false,
      type: "CNAME",
      content: `${key}.${zone.name}.${dkimDomain}`,
      ttl: 1,
    });
  }

  new cloudflare.DnsRecord(`${zone.name}-fm-spf`, {
    ...zone,
    type: "TXT",
    content: `"v=spf1 include:${spfDomain} ?all"`,
    ttl: 1,
  });

  new cloudflare.DnsRecord(`${zone.name}-fm-dmarc`, {
    ...zone,
    name: dmarcSubdomain,
    type: "TXT",
    content: `"v=DMARC1; p=${dmarcPolicy}; rua=mailto:${dmarcAggEmail}"`,
    ttl: 1,
  });
}
