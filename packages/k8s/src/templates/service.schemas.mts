import { z } from "zod";
import {
  HostVolumeSchema,
  ImageSchema,
  LimitsSchema,
  PersistenceSchema,
} from "./schemas.mts";

export const ServiceArgsSchema = z.object({
  image: ImageSchema,
  replicas: z.number().default(1),
  env: z.record(z.string(), z.string()).default({}),
  httpPort: z.number().default(80),
  limits: LimitsSchema.default({
    // TODO: Find better way
    cpu: "64Mi",
    memory: "50m",
  }),
  hostVolumes: z.array(HostVolumeSchema).default([]),
  persistence: z.array(PersistenceSchema).default([]),
});
