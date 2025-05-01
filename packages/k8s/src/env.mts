import { EnvSchema } from "./env.schema.mts";

export const env = EnvSchema.parse(process.env);
