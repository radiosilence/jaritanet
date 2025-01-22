import { z } from "zod";

export const CloudflaredArgsSchema = z.object({
  replicas: z.number().default(2),
});

export type CloudflaredArgs = z.infer<typeof CloudflaredArgsSchema>;
