import { z } from "zod";
import { CloudflaredArgsSchema, ServiceArgsSchema } from "./templates";

export const CloudflaredConfSchema = z.object({
  name: z.string(),
  args: CloudflaredArgsSchema.default({}),
});

export type CloudflaredConf = z.infer<typeof CloudflaredConfSchema>;

export const ServiceConfSchema = z.object({
  name: z.string(),
  hostname: z.string(),
  proxied: z.boolean().default(true),
  args: ServiceArgsSchema,
});
export type ServiceConf = z.infer<typeof ServiceConfSchema>;

export const ServicesArraySchema = z.array(ServiceConfSchema);
export type ServicesArray = z.infer<typeof ServicesArraySchema>;
