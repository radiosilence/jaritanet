import * as z from "zod";
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
  hostname: z.string().optional(),
  proxied: z.boolean().default(true),
  args: ServiceArgsSchema,
});

export const ServicesMapSchema = z.record(
  z.string(),
  ServiceConfSchema.omit({ name: true }),
);

export const K8sConfSchema = z.object({
  cloudflare: CloudflareConfSchema,
  cloudflared: CloudflaredConfSchema,
  services: ServicesMapSchema,
  namespace: z.string().default("jaritanet"),
  infraStackPath: z.string().default("radiosilence/jaritanet"),
  managedBy: z.string().default("jaritanet"),
  clusterDomain: z.string().default("cluster.local"),
});
