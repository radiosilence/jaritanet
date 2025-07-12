import * as cloudflare from "@pulumi/cloudflare";

import type { z } from "zod/v4";
import type { ZoneConfSchema } from "../conf.schemas.ts";

/**
 * Bluesky DNS records, configured globally.
 *
 * @param zone - The zone to create the record in.
 */
export async function bluesky(zone: z.infer<typeof ZoneConfSchema>) {
  const { conf } = await import("../conf.ts");

  new cloudflare.DnsRecord(`${zone.name}-bs-did`, {
    ...zone,
    type: "TXT",
    name: "_atproto",
    content: `"did=${conf.bluesky.did}"`,
    ttl: 1,
  });
}
