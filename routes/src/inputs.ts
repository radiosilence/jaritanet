import { z } from "zod";

export const ServiceOutputSchema = z.object({
  service: z.string(),
  hostname: z.string(),
  proxied: z.boolean(),
});

export type ServiceOutput = z.infer<typeof ServiceOutputSchema>;
