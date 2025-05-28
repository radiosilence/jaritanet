import { z } from "zod";
import { HealthCheckConfigSchema } from "./healthcheck.schemas.ts";
import {
  HostVolumeSchema,
  ImageSchema,
  LIMITS_DEFAULT,
  LimitsSchema,
  PersistenceSchema,
} from "./schemas.ts";

export const ServiceArgsSchema = z.object({
  image: ImageSchema,
  replicas: z.uint32().default(1),
  env: z.record(z.string(), z.string()).default({}),
  httpPort: z.uint32().default(80),
  limits: LimitsSchema.default(LIMITS_DEFAULT),
  hostVolumes: z.array(HostVolumeSchema).default([]),
  persistence: z.array(PersistenceSchema).default([]),
  healthCheck: HealthCheckConfigSchema.optional(),
});
