import { z } from "zod/v4";

export function outputDetails<T>(schema: z.ZodType<T>) {
  return z.object({
    value: schema,
  });
}

export function outputDetailsSecret<T>(schema: z.ZodType<T>) {
  return z.object({
    secretValue: schema,
  });
}

export const TunnelSchema = z.object({
  id: z.string(),
});
