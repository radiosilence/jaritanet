import { EnvSchema } from "./env.schema";

export const env = EnvSchema.parse(process.env);
