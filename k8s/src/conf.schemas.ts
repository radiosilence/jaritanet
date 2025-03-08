import { z } from "zod";
import { CloudflaredArgsSchema } from "./templates/cloudflared.schemas";
import { ServiceArgsSchema } from "./templates/service.schemas";

export const CloudflaredConfSchema = z.object({
  name: z.string(),
  args: CloudflaredArgsSchema.default({}),
});

export const ServiceConfSchema = z.object({
  name: z.string(),
  hostname: z.string(),
  proxied: z.boolean().default(true),
  args: ServiceArgsSchema,
});

export const ServicesArraySchema = z.array(ServiceConfSchema);
