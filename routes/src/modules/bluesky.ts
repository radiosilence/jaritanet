import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

import type { BlueskyConf, ZoneConf } from "../conf.schemas";

const config = new pulumi.Config();

const { did } = config.requireObject<BlueskyConf>("bluesky");

/**
 * Bluesky DNS records, configured globally.
 *
 * @param zone - The zone to create the record in.
 */
export function bluesky(zone: ZoneConf) {
  new cloudflare.Record(`${zone.name}-bs-did`, {
    ...zone,
    type: "TXT",
    name: "_atproto",
    content: `"did=${did}"`,
  });
}
