import { z } from "zod";
import {
  HostVolumeSchema,
  ImageSchema,
  LimitsSchema,
  PortsSchema,
} from "./schemas";

export const StaticServiceArgsSchema = z.object({
  image: ImageSchema,
  replicas: z.number().default(1),
  env: z.record(z.string()).default({}),
  ports: PortsSchema,
  limits: LimitsSchema,
  hostVolumes: z.array(HostVolumeSchema).default([]),
});

export type StaticServiceArgs = z.infer<typeof StaticServiceArgsSchema>;
