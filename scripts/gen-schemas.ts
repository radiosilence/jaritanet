#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import fs from "node:fs/promises";
import * as z from "zod";
import { ConfSchema } from "../packages/infra/src/conf.schemas.ts";

const PROJECT = "jaritanet";
const SCHEMAS_PATH = "./schemas";

/** The shape Pulumi leaves behind when it encrypts a value in place. */
const SECURE = {
  type: "object",
  properties: { secure: { type: "string" } },
  required: ["secure"],
  additionalProperties: false,
} as const;

/**
 * Lets any string also be written as `{ secure: "..." }`.
 *
 * Encrypting a config value replaces the leaf with that wrapper, anywhere in
 * the tree. Without this the editor reports every credential in
 * Pulumi.main.yaml as a type error, which teaches people to ignore the squiggle
 * that would have caught a real mistake.
 *
 * Strings only. A secret decrypts to a string whatever it was written as, so
 * securing a number reaches Zod as one and fails to parse — leaving those
 * strict means the schema says so where it is written, not at deploy.
 */
const allowSecrets: NonNullable<
  Parameters<typeof z.toJSONSchema>[1]
>["override"] = ({ jsonSchema }) => {
  if (jsonSchema.type !== "string") return;
  const plain = { ...jsonSchema };
  for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
  jsonSchema.anyOf = [plain, SECURE];
};

const schemas = {
  // Derived from ConfSchema rather than listed here, so a key added to the
  // stack's config surface cannot go missing from the schema validating it.
  infra: z
    .object({
      config: z.object({
        ...Object.fromEntries(
          Object.entries(ConfSchema.shape).map(([key, schema]) => [
            `${PROJECT}:${key}`,
            schema,
          ]),
        ),
        // Provider config, in the providers' own namespaces rather than this
        // project's. Each holds the same value the program reads from its own
        // key; this is the copy the provider authenticates with.
        "cloudflare:apiToken": z.string(),
        "hcloud:token": z.string(),
      }),
    })
    .meta({
      description: "Schema for infrastructure configuration",
      id: "https://raw.githubusercontent.com/radiosilence/jaritanet/main/schemas/infra.json",
      title: "Infrastructure Configuration Schema",
    }),
} as const;

await fs.mkdir(SCHEMAS_PATH, { recursive: true });

await Promise.all(
  Object.entries(schemas).map(async ([name, schema]) => {
    const json = z.toJSONSchema(schema, {
      io: "input",
      reused: "ref",
      override: allowSecrets,
    });
    await fs.writeFile(
      `${SCHEMAS_PATH}/${name}.json`,
      `${JSON.stringify(json, null, 2)}\n`,
    );
  }),
);
