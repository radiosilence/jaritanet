import { z } from "zod";
import {
  HostVolumeSchema,
  ImageSchema,
  LimitsSchema,
  PortsSchema,
} from "./schemas";

export const LocalStorageServiceArgsSchema = z.object({
  image: ImageSchema,
  env: z.record(z.string()).default({}),
  ports: PortsSchema,
  limits: LimitsSchema,
  hostVolumes: z.array(HostVolumeSchema).default([]),
});

export type LocalStorageServiceArgs = z.infer<
  typeof LocalStorageServiceArgsSchema
>;
