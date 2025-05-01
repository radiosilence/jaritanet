import { z } from "zod";
import {
  HostVolumeSchema,
  ImageSchema,
  LIMITS_DEFAULT,
  LimitsSchema,
  PersistenceSchema,
} from "./schemas.ts";

export const ServiceArgsSchema = z.object({
  image: ImageSchema,
  replicas: z.number().default(1),
  env: z.record(z.string(), z.string()).default({}),
  httpPort: z.number().default(80),
  limits: LimitsSchema.default(LIMITS_DEFAULT),
  hostVolumes: z.array(HostVolumeSchema).default([]),
  persistence: z.array(PersistenceSchema).default([]),
});
