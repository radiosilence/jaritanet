import { z } from "zod";
import { PortsSchema } from "./schemas";

export const StaticServiceArgsSchema = z.object({
  image: z.object({
    repository: z.string(),
    tag: z.string(),
  }),
  ports: PortsSchema,
});

export type StaticServiceArgs = z.infer<typeof StaticServiceArgsSchema>;
