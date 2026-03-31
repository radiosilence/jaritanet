#!/usr/bin/env bun
import fs from "node:fs/promises";
import * as z from "zod";

const PROJECT = "jaritanet";
const SCHEMAS_PATH = "./schemas";
const CloudflareApiSchema = z.object({
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
          description: "Schema for infra configuration",
          id: "https://raw.githubusercontent.com/radiosilence/jaritanet/main/schemas/infra.json",
          title: "Infra Configuration Schema",
        }),
  ),
  k8s: await import("../packages/k8s/src/conf.schemas.ts").then(
    ({ CloudflareConfSchema, CloudflaredConfSchema, ServicesMapSchema }) =>
      z
        .object({
          config: z.object({
            [`${PROJECT}-k8s:cloudflare`]: CloudflareConfSchema,
            [`${PROJECT}-k8s:services`]: ServicesMapSchema,
            [`${PROJECT}-k8s:cloudflared`]: CloudflaredConfSchema,
            "cloudflare:apiToken": CloudflareApiSchema,
          }),
        })
        .meta({
          description: "Schema for Kubernetes configuration",
          id: "https://raw.githubusercontent.com/radiosilence/jaritanet/main/schemas/k8s.json",
          title: "Kubernetes Configuration Schema",
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
          description: "Schema for routes configuration",
          id: "https://raw.githubusercontent.com/radiosilence/jaritanet/main/schemas/routes.json",
          title: "Routes Configuration Schema",
        }),
  ),
} as const;

await Promise.all(Object.entries(schemas).map(dumpSchema));
