import * as z from "zod";
import { HealthCheckConfigSchema } from "./healthcheck.schemas.ts";
import {
  HostVolumeSchema,
  ImageSchema,
  LimitsSchema,
  PersistenceSchema,
  SecurityContextSchema,
} from "./schemas.ts";

export const SyncthingArgsSchema = z.object({
  image: ImageSchema,
  env: z.record(z.string(), z.string()).default({}),
  httpPort: z.uint32().default(8384),
  ports: z.array(z.tuple([z.number(), z.number()])).default([]),
  limits: LimitsSchema.optional(),
  hostVolumes: z.array(HostVolumeSchema).default([]),
  persistence: z.array(PersistenceSchema).default([]),
  healthCheck: HealthCheckConfigSchema.optional(),
  securityContext: SecurityContextSchema.optional(),
});
