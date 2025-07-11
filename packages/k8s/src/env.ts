import { EnvSchema } from "./env.schema.ts";

export const env = EnvSchema.parse(process.env);
