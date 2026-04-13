import * as z from "zod";

export const EnvSchema = z.object({
  CLOUDFLARE_API_TOKEN: z.string().min(1, "CLOUDFLARE_API_TOKEN is required"),
  KUBE_API_PORT: z.string().min(1, "KUBE_API_PORT is required"),
  KUBE_HOST: z.string().min(1, "KUBE_HOST is required"),
  KUBE_TOKEN: z.string().min(1, "KUBE_TOKEN is required"),
});
