import { z } from "zod";
import {
  LocalStorageServiceArgsSchema,
  StaticServiceArgsSchema,
} from "./templates";

export const CloudflaredConfSchema = z.object({
  name: z.string(),
});

export type CloudflaredConf = z.infer<typeof CloudflaredConfSchema>;

export const LocalStorageServiceConfSchema = z.object({
  template: z.literal("local-storage"),
  args: LocalStorageServiceArgsSchema,
});

export type LocalStorageServiceConf = z.infer<
  typeof LocalStorageServiceConfSchema
>;

const StaticServiceConfSchema = z.object({
  template: z.literal("static"),
  args: StaticServiceArgsSchema,
});

export type StaticServiceConf = z.infer<typeof StaticServiceConfSchema>;

export const ServiceConfSchema = z
  .object({
    name: z.string(),
    hostname: z.string(),
  })
  .and(
    z.discriminatedUnion("template", [
      LocalStorageServiceConfSchema,
      StaticServiceConfSchema,
    ]),
  );
export type ServiceConf = z.infer<typeof ServiceConfSchema>;

export const ServicesArraySchema = z.array(ServiceConfSchema);
export type ServicesArray = z.infer<typeof ServicesArraySchema>;
