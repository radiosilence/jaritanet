import * as z from "zod";
import { CloudflaredArgsSchema } from "./templates/cloudflared.schemas.ts";
import { ServiceArgsSchema } from "./templates/service.schemas.ts";
import { SyncthingArgsSchema } from "./templates/syncthing.schemas.ts";

export const CloudflareConfSchema = z.object({
  accountId: z.string(),
});

export const CloudflaredConfSchema = z.object({
  name: z.string(),
  args: CloudflaredArgsSchema,
});

const BaseServiceConfSchema = z.object({
  name: z.string(),
  hostname: z.string(),
  proxied: z.boolean().default(true),
});

const ServiceConfVariantSchema = BaseServiceConfSchema.extend({
  type: z.literal("service").default("service"),
  args: ServiceArgsSchema,
});

const SyncthingConfVariantSchema = BaseServiceConfSchema.extend({
  type: z.literal("syncthing"),
  args: SyncthingArgsSchema,
});

export const ServiceConfSchema = z.discriminatedUnion("type", [
  ServiceConfVariantSchema,
  SyncthingConfVariantSchema,
]);

const ServiceConfWithoutNameSchema = z.discriminatedUnion("type", [
  ServiceConfVariantSchema.omit({ name: true }),
  SyncthingConfVariantSchema.omit({ name: true }),
]);

export const ServicesMapSchema = z.record(
  z.string(),
  ServiceConfWithoutNameSchema,
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
