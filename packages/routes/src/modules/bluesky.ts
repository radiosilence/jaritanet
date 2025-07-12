import * as cloudflare from "@pulumi/cloudflare";

import type { z } from "zod/v4";
import type { ZoneConfSchema } from "../conf.schemas.ts";
import { conf } from "../conf.ts";

/**
 * Bluesky DNS records, configured globally.
 *
 * @param zone - The zone to create the record in.
 */
export function bluesky(zone: z.infer<typeof ZoneConfSchema>) {
  new cloudflare.DnsRecord(`${zone.name}-bs-did`, {
    ...zone,
    type: "TXT",
    name: "_atproto",
    content: `"did=${conf.bluesky.did}"`,
    ttl: 1,
  });
}
