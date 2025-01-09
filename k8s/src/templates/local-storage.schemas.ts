import { z } from "zod";
import {
  HostVolumeSchema,
  ImageSchema,
  LimitsSchema,
  PortsSchema,
} from "./schemas";

export const LocalStorageServiceArgsSchema = z.object({
  env: z.record(z.string()).optional(),
  ports: PortsSchema,
  hostVolumes: z.array(HostVolumeSchema).default([]),
  image: ImageSchema,
  limits: LimitsSchema,
});

export type LocalStorageServiceArgs = z.infer<
  typeof LocalStorageServiceArgsSchema
>;
