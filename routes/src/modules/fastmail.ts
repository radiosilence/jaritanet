import * as cloudflare from "@pulumi/cloudflare";
import type { z } from "zod";
import { conf } from "../conf";
import type { ZoneConfSchema } from "../conf.schemas";

const {
  mxDomain,
  dkimDomain,
  dkimSubdomain,
  dmarcSubdomain,
  dmarcAggEmail,
  dmarcPolicy,
  spfDomain,
} = conf.fastmail;

/**
 * Fastmail DNS records, configured globally.
 *
 * @param zone - The zone to create the record in.
 */
export function fastmail(zone: z.infer<typeof ZoneConfSchema>) {
  for (const [key, value] of Object.entries({ in1: 10, in2: 20 })) {
    new cloudflare.Record(`${zone.name}-fm-mx-${key}`, {
      ...zone,
      priority: value,
      type: "MX",
      content: `${key}.${mxDomain}`,
    });
  }

  for (const key of ["fm1", "fm2", "fm3", "fm4"]) {
    new cloudflare.Record(`${zone.name}-fm-dkim-${key}`, {
      ...zone,
      name: `${key}.${dkimSubdomain}`,
      proxied: false,
      type: "CNAME",
      content: `${key}.${zone.name}.${dkimDomain}`,
    });
  }

  new cloudflare.Record(`${zone.name}-fm-spf`, {
    ...zone,
    type: "TXT",
    content: `"v=spf1 include:${spfDomain} ?all"`,
  });

  new cloudflare.Record(`${zone.name}-fm-dmarc`, {
    ...zone,
    name: dmarcSubdomain,
    type: "TXT",
    content: `"v=DMARC1; p=${dmarcPolicy}; rua=mailto:${dmarcAggEmail}"`,
  });
}
