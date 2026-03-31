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
      content: `${key}.${mxDomain}`,
      priority: value,
      ttl: 1,
      type: "MX",
    });
  }

  for (const key of ["fm1", "fm2", "fm3", "fm4"]) {
    new cloudflare.DnsRecord(`${zone.name}-fm-dkim-${key}`, {
      ...zone,
      content: `${key}.${zone.name}.${dkimDomain}`,
      name: `${key}.${dkimSubdomain}`,
      proxied: false,
      ttl: 1,
      type: "CNAME",
    });
  }

  new cloudflare.DnsRecord(`${zone.name}-fm-spf`, {
    ...zone,
    content: `"v=spf1 include:${spfDomain} ?all"`,
    ttl: 1,
    type: "TXT",
  });

  new cloudflare.DnsRecord(`${zone.name}-fm-dmarc`, {
    ...zone,
    content: `"v=DMARC1; p=${dmarcPolicy}; rua=mailto:${dmarcAggEmail}"`,
    name: dmarcSubdomain,
    ttl: 1,
    type: "TXT",
  });
}
