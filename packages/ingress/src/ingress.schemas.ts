import * as z from "zod";

export const TraefikConfSchema = z.object({
  acmeEmail: z.email(),
  chartVersion: z.string().default("41.0.2"),
});
