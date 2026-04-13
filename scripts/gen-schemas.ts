#!/usr/bin/env bun
import fs from "node:fs/promises";
import * as z from "zod";

const PROJECT = "jaritanet";
const SCHEMAS_PATH = "./schemas";
const CloudflareApiSchema = z.object({
  secure: z.string(),
});
const HcloudTokenSchema = z.object({
  secure: z.string(),
});

try {
  await fs.lstat(SCHEMAS_PATH);
} catch {
  await fs.mkdir(SCHEMAS_PATH);
}

async function dumpSchema([name, schema]: [name: string, schema: z.ZodType]) {
  await fs.writeFile(
    `${SCHEMAS_PATH}/${name}.json`,
    JSON.stringify(
      z.toJSONSchema(schema, { io: "input", reused: "ref" }),
      null,
      2,
    ),
  );
}

const schemas = {
  infra: await import("../packages/infra/src/conf.schemas.ts").then(
    ({
      CloudflareConfSchema,
      GatewayConfSchema,
      TraefikConfSchema,
      ServicesMapSchema,
      ZonesConfSchema,
      FastmailConfSchema,
      BlueskyConfSchema,
    }) =>
      z
        .object({
          config: z.object({
            [`${PROJECT}:cloudflare`]: CloudflareConfSchema,
            [`${PROJECT}:gateway`]: GatewayConfSchema,
            [`${PROJECT}:traefik`]: TraefikConfSchema,
            [`${PROJECT}:services`]: ServicesMapSchema,
            [`${PROJECT}:zones`]: ZonesConfSchema,
            [`${PROJECT}:fastmail`]: FastmailConfSchema,
            [`${PROJECT}:bluesky`]: BlueskyConfSchema,
            "cloudflare:apiToken": CloudflareApiSchema,
            "hcloud:token": HcloudTokenSchema,
          }),
        })
        .meta({
          description: "Schema for infrastructure configuration",
          id: "https://raw.githubusercontent.com/radiosilence/jaritanet/main/schemas/infra.json",
          title: "Infrastructure Configuration Schema",
        }),
  ),
} as const;

await Promise.all(Object.entries(schemas).map(dumpSchema));
