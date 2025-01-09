import { z } from "zod";
import { ServiceArgsSchema } from "./templates";

export const CloudflaredConfSchema = z.object({
  name: z.string(),
});

export type CloudflaredConf = z.infer<typeof CloudflaredConfSchema>;

export const ServiceConfSchema = z.object({
  name: z.string(),
  hostname: z.string(),
  args: ServiceArgsSchema,
});
export type ServiceConf = z.infer<typeof ServiceConfSchema>;

export const ServicesArraySchema = z.array(ServiceConfSchema);
export type ServicesArray = z.infer<typeof ServicesArraySchema>;
