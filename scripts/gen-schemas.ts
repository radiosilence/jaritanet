#!/usr/bin/env bun
import fs from "node:fs/promises";
import { type ZodType, z } from "zod/v4";

const PROJECT = "jaritanet";
const SCHEMAS_PATH = "./schemas";
const CloudflareApiSchema = z.object({
  secure: z.string(),
});

try {
  await fs.lstat(SCHEMAS_PATH);
} catch (_e) {
  await fs.mkdir(SCHEMAS_PATH);
}

async function dumpSchema([name, schema]: [name: string, schema: ZodType]) {
  await fs.writeFile(
    `${SCHEMAS_PATH}/${name}.json`,
    JSON.stringify(
      z.toJSONSchema(schema, { reused: "ref", io: "input" }),
      null,
      2,
    ),
  );
}

const schemas = {
  infra: await import("../packages/infra/src/conf.schemas.ts").then(
    ({ CloudflareConfSchema, TunnelConfSchema }) =>
      z
        .object({
          config: z.object({
            [`${PROJECT}:cloudflare`]: CloudflareConfSchema,
            [`${PROJECT}:tunnel`]: TunnelConfSchema,
            "cloudflare:apiToken": CloudflareApiSchema,
          }),
        })
        .meta({
          id: "https://raw.githubusercontent.com/radiosilence/jaritanet/main/schemas/infra.json",
          title: "Infra Configuration Schema",
          description: "Schema for infra configuration",
        }),
  ),
  k8s: await import("../packages/k8s/src/conf.schemas.ts").then(
    ({ CloudflareConfSchema, CloudflaredConfSchema, ServicesArraySchema }) =>
      z
        .object({
          config: z.object({
            [`${PROJECT}-k8s:cloudflare`]: CloudflareConfSchema,
            [`${PROJECT}-k8s:services`]: ServicesArraySchema,
            [`${PROJECT}-k8s:cloudflared`]: CloudflaredConfSchema,
            "cloudflare:apiToken": CloudflareApiSchema,
          }),
        })
        .meta({
          id: "https://raw.githubusercontent.com/radiosilence/jaritanet/main/schemas/k8s.json",
          title: "Kubernetes Configuration Schema",
          description: "Schema for Kubernetes configuration",
        }),
  ),
  routes: await import("../packages/routes/src/conf.schemas.ts").then(
    ({
      CloudflareConfSchema,
      ServiceStacksConfSchema,
      ZonesConfSchema,
      BlueskyConfSchema,
      FastmailConfSchema,
    }) =>
      z
        .object({
          config: z.object({
            [`${PROJECT}-routes:cloudflare`]: CloudflareConfSchema,
            [`${PROJECT}-routes:zones`]: ZonesConfSchema,
            [`${PROJECT}-routes:serviceStacks`]: ServiceStacksConfSchema,
            [`${PROJECT}-routes:bluesky`]: BlueskyConfSchema,
            [`${PROJECT}-routes:fastmail`]: FastmailConfSchema,
            "cloudflare:apiToken": CloudflareApiSchema,
          }),
        })
        .meta({
          id: "https://raw.githubusercontent.com/radiosilence/jaritanet/main/schemas/routes.json",
          title: "Routes Configuration Schema",
          description: "Schema for routes configuration",
        }),
  ),
} as const;

await Promise.all(Object.entries(schemas).map(dumpSchema));
