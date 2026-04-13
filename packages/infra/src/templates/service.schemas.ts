import * as z from "zod";
import { HealthCheckConfigSchema } from "./healthcheck.schemas.ts";
import {
  HostVolumeSchema,
  ImageSchema,
  LimitsSchema,
  PersistenceSchema,
  SecurityContextSchema,
  StrategySchema,
} from "./schemas.ts";

export const ServiceArgsSchema = z.object({
  env: z.record(z.string(), z.string()).default({}),
  healthCheck: HealthCheckConfigSchema.optional(),
  hostVolumes: z.array(HostVolumeSchema).default([]),
  httpPort: z.uint32().default(80),
  image: ImageSchema,
  limits: LimitsSchema.optional(),
  persistence: z.array(PersistenceSchema).default([]),
  ports: z.array(z.tuple([z.number(), z.number()])).default([]),
  replicas: z.uint32().default(1),
  securityContext: SecurityContextSchema.optional(),
  strategy: StrategySchema.optional(),
});
