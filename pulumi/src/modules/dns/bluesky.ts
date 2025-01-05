import * as cloudflare from "@pulumi/cloudflare";

import { type ZoneConf } from "../../types";

interface BlueskyArgs {
  did?: string;
}

export function bluesky(
  zone: ZoneConf,
  { did = "did:plc:d32vuqlfqjttwbckkxgxgbgl" }: BlueskyArgs = {}
) {
  new cloudflare.Record(`${zone.name}-bs-did`, {
    ...zone,
    ttl: 1,
    type: "TXT",
    name: "_did",
    content: `"${did}"`,
  });
}
