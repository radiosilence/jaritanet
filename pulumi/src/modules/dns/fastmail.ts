import * as cloudflare from "@pulumi/cloudflare";

import { type ZoneConf } from "../../types";

interface FastmailArgs {
  mxDomain?: string;
  dkimDomain?: string;
  dkimSubdomain?: string;
  dmarcSubdomain?: string;
  dmarcAggEmail?: string;
  dmarcPolicy?: string;
  spfDomain?: string;
}

export function fastmail(
  zone: ZoneConf,
  {
    mxDomain = "smtp.messagingengine.com",
    dkimDomain = "dkim.fmhosted.com",
    dkimSubdomain = "_domainkey",
    dmarcSubdomain = "_dmarc",
    dmarcAggEmail = "dmarc-agg@blit.cc",
    dmarcPolicy = "reject",
    spfDomain = "spf.messagingengine.com",
  }: FastmailArgs = {}
) {
  for (const [key, value] of Object.entries({ in1: 10, in2: 20 })) {
    new cloudflare.Record(`${zone.name}-fm-mx-${key}`, {
      ...zone,
      priority: value,
      ttl: 1,
      type: "MX",
      content: `${key}.${mxDomain}`,
    });
  }

  for (const key of ["fm1", "fm2", "fm3", "fm4"]) {
    new cloudflare.Record(`${zone.name}-fm-dkim-${key}`, {
      ...zone,
      name: `${key}.${dkimSubdomain}`,
      proxied: false,
      ttl: 1,
      type: "CNAME",
      content: `${key}.${zone.name}.${dkimDomain}`,
    });
  }

  new cloudflare.Record(`${zone.name}-fm-spf`, {
    ...zone,
    ttl: 1,
    type: "TXT",
    content: `"v=spf1 include:${spfDomain} ?all"`,
  });

  new cloudflare.Record(`${zone.name}-fm-dmarc`, {
    ...zone,
    name: dmarcSubdomain,
    ttl: 1,
    type: "TXT",
    content: `"v=DMARC1; p=${dmarcPolicy}; rua=mailto:${dmarcAggEmail}"`,
  });
}
