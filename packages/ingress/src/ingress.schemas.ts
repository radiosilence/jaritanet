import * as z from "zod";

export const TraefikConfSchema = z.object({
  acmeEmail: z.string(),
  chartVersion: z.string().default("41.0.2"),
});
