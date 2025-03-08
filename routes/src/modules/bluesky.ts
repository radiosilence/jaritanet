import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

import { parse } from "@schema-hub/zod-error-formatter";
import type { z } from "zod";
import { BlueskyConfSchema, type ZoneConfSchema } from "../conf.schemas";

const config = new pulumi.Config();

const { did } = parse(BlueskyConfSchema, config.requireObject("bluesky"));

/**
 * Bluesky DNS records, configured globally.
 *
 * @param zone - The zone to create the record in.
 */
export function bluesky(zone: z.infer<typeof ZoneConfSchema>) {
  new cloudflare.Record(`${zone.name}-bs-did`, {
    ...zone,
    type: "TXT",
    name: "_atproto",
    content: `"did=${did}"`,
  });
}
