import { z } from "zod/v4";

export const CloudflaredArgsSchema = z.object({
  replicas: z.uint32(),
  image: z.string().default("cloudflare/cloudflared:latest"),
  resources: z
    .object({
      limits: z.object({
        memory: z.string().default("128Mi"),
        cpu: z.string().default("250m"),
      }),
    })
    .default({
      limits: {
        memory: "128Mi",
        cpu: "250m",
      },
    }),
});
