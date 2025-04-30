import { z } from "zod";

export const outputDetails = <T>(schema: z.ZodType<T>) =>
  z.object({
    value: schema,
  });

export const outputDetailsSecret = <T>(schema: z.ZodType<T>) =>
  z.object({
    secretValue: schema,
  });

export const TunnelSchema = z.object({
  id: z.string(),
});
