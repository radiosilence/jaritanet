import * as z from "zod";
import { CloudflaredArgsSchema } from "./templates/cloudflared.schemas.ts";
import { ServiceArgsSchema } from "./templates/service.schemas.ts";

export const CloudflareConfSchema = z.object({
  accountId: z.string(),
});

export const CloudflaredConfSchema = z.object({
  args: CloudflaredArgsSchema,
  name: z.string(),
});

export const ServiceConfSchema = z.object({
  args: ServiceArgsSchema,
  hostname: z.string().optional(),
  name: z.string(),
  proxied: z.boolean().default(true),
});

export const ServicesMapSchema = z.record(
  z.string(),
  ServiceConfSchema.omit({ name: true }),
);

export const K8sConfSchema = z.object({
  cloudflare: CloudflareConfSchema,
  cloudflared: CloudflaredConfSchema,
  clusterDomain: z.string().default("cluster.local"),
  infraStackPath: z.string().default("radiosilence/jaritanet"),
  managedBy: z.string().default("jaritanet"),
  namespace: z.string().default("jaritanet"),
  services: ServicesMapSchema,
});
