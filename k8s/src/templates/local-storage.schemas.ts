import { z } from "zod";
import { ImageSchema, PortsSchema, VolumeSchema } from "./schemas";

export const LocalStorageServiceArgsSchema = z.object({
  env: z.record(z.string()).optional(),
  ports: PortsSchema,
  persistence: z.record(VolumeSchema),
  image: ImageSchema,
  resources: z.object({
    limits: z.object({
      memory: z.string(),
      cpu: z.string(),
    }),
  }),
  nodeSelector: z.object({
    key: z.string(),
    operator: z.string(),
    values: z.array(z.string()),
  }),
});

export type LocalStorageServiceArgs = z.infer<
  typeof LocalStorageServiceArgsSchema
>;
