import { z } from "zod";

export const CloudflaredArgsSchema = z.object({
  replicas: z.number().optional(),
});

export type CloudflaredArgs = z.infer<typeof CloudflaredArgsSchema>;
