import { z } from "zod";
import { StaticServiceArgsSchema } from "./templates";

export const CloudflaredConfSchema = z.object({
  name: z.string(),
});

export type CloudflaredConf = z.infer<typeof CloudflaredConfSchema>;

const StaticServiceConfSchema = z.object({
  template: z.literal("web"),
  args: StaticServiceArgsSchema,
});

export type StaticServiceConf = z.infer<typeof StaticServiceConfSchema>;

export const ServiceConfSchema = z
  .object({
    name: z.string(),
    hostname: z.string(),
  })
  .and(z.discriminatedUnion("template", [StaticServiceConfSchema]));
export type ServiceConf = z.infer<typeof ServiceConfSchema>;

export const ServicesArraySchema = z.array(ServiceConfSchema);
export type ServicesArray = z.infer<typeof ServicesArraySchema>;
