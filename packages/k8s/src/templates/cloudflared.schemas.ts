import { z } from "zod";

export const CloudflaredArgsSchema = z.object({
  replicas: z.number(),
});
