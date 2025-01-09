import { z } from "zod";
import { LimitsSchema, PortsSchema } from "./schemas";

export const StaticServiceArgsSchema = z.object({
  image: z.object({
    repository: z.string(),
    tag: z.string(),
  }),
  ports: PortsSchema,
  limits: LimitsSchema,
});

export type StaticServiceArgs = z.infer<typeof StaticServiceArgsSchema>;
