import { z } from "zod";
import { CloudflaredArgsSchema } from "./templates/cloudflared.schemas.ts";
import { GrafanaArgsSchema } from "./templates/grafana.schemas.ts";
import { PrometheusArgsSchema } from "./templates/prometheus.schemas.ts";
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

export const PrometheusConfSchema = z.object({
  name: z.string(),
  hostname: z.string().optional(),
  proxied: z.boolean().default(false),
  args: PrometheusArgsSchema,
});

export const GrafanaConfSchema = z.object({
  name: z.string(),
  hostname: z.string().optional(),
  proxied: z.boolean().default(false),
  args: GrafanaArgsSchema,
});

export const MonitoringConfSchema = z.object({
  prometheus: PrometheusConfSchema,
  grafana: GrafanaConfSchema,
});

export const K8sConfSchema = z.object({
  cloudflare: CloudflareConfSchema,
  cloudflared: CloudflaredConfSchema,
  monitoring: MonitoringConfSchema.optional(),
  services: ServicesArraySchema,
});
