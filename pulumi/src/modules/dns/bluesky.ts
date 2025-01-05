import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

import type { ZoneConf, BlueskyConf } from "../../types";

const config = new pulumi.Config();

const { did } = config.requireObject<BlueskyConf>("bluesky");

export function bluesky(zone: ZoneConf) {
  new cloudflare.Record(`${zone.name}-bs-did`, {
    ...zone,
    type: "TXT",
    name: "_atproto",
    content: `"${did}"`,
  });
}
