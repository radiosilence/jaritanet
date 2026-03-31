import * as z from "zod";

export const CloudflaredArgsSchema = z.object({
  image: z.string().default("cloudflare/cloudflared:latest"),
  replicas: z.uint32(),
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
