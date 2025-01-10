import { z } from "zod";
import {
  HostVolumeSchema,
  ImageSchema,
  LimitsSchema,
  PersistenceSchema,
} from "./schemas";

export const ServiceArgsSchema = z.object({
  image: ImageSchema,
  replicas: z.number().default(1),
  env: z.record(z.string()).default({}),
  httpPort: z.number().default(80),
  limits: LimitsSchema,
  hostVolumes: z.array(HostVolumeSchema).default([]),
  persistence: z.array(PersistenceSchema).default([]),
});

export type ServiceArgs = z.infer<typeof ServiceArgsSchema>;
