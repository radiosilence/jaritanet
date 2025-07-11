import { z } from "zod/v4";
import { CloudflaredArgsSchema } from "./templates/cloudflared.schemas.ts";
import { ServiceArgsSchema } from "./templates/service.schemas.ts";

export const CloudflareConfSchema = z.object({
  accountId: z.string(),
});

export const CloudflaredConfSchema = z.object({
  name: z.string(),
  args: CloudflaredArgsSchema,
});

export const ServiceConfSchema = z.object({
  name: z.string(),
  hostname: z.string(),
  proxied: z.boolean().default(true),
  args: ServiceArgsSchema,
});

export const ServicesArraySchema = z.array(ServiceConfSchema);

export const K8sConfSchema = z.object({
  cloudflare: CloudflareConfSchema,
  cloudflared: CloudflaredConfSchema,
  services: ServicesArraySchema,
  namespace: z.string().default("jaritanet"),
  infraStackPath: z.string().default("radiosilence/jaritanet"),
  managedBy: z.string().default("jaritanet"),
  clusterDomain: z.string().default("cluster.local"),
});
