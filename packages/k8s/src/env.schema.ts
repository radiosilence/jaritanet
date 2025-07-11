import { z } from "zod/v4";

// Environment validation schema
export const EnvSchema = z.object({
  KUBE_HOST: z.string().min(1, "KUBE_HOST is required"),
  KUBE_API_PORT: z.string().min(1, "KUBE_API_PORT is required"),
  KUBE_TOKEN: z.string().min(1, "KUBE_TOKEN is required"),
});
