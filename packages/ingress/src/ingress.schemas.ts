import * as z from "zod";

export const TraefikConfSchema = z.object({
  acmeEmail: z.email(),
});
