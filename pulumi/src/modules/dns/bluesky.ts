import * as cloudflare from "@pulumi/cloudflare";

import { type ZoneConf } from "@/types";

interface BlueskyProps {
  zone: ZoneConf;
  did?: string;
}

export function bluesky({
  zone,
  did = "did:plc:d32vuqlfqjttwbckkxgxgbgl",
}: BlueskyProps) {
  new cloudflare.Record(`${zone.name}-bs-did`, {
    ...zone,
    ttl: 1,
    type: "TXT",
    name: "_did",
    content: `"${did}"`,
  });
}
