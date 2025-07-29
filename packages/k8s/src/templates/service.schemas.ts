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
  image: ImageSchema,
  replicas: z.uint32().default(1),
  env: z.record(z.string(), z.string()).default({}),
  httpPort: z.uint32().default(80),
  ports: z.array(z.tuple([z.number(), z.number()])).default([]),
  limits: LimitsSchema.optional(),
  hostVolumes: z.array(HostVolumeSchema).default([]),
  persistence: z.array(PersistenceSchema).default([]),
  healthCheck: HealthCheckConfigSchema.optional(),
  strategy: StrategySchema.optional(),
  securityContext: SecurityContextSchema.optional(),
});
