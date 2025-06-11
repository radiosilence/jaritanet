import { z } from "zod/v4";

export const HostVolumeSchema = z.object({
  name: z.string(),
  hostPath: z.string(),
  hostPathType: z
    .enum([
      "DirectoryOrCreate",
      "Directory",
      "FileOrCreate",
      "File",
      "Socket",
      "CharDevice",
      "BlockDevice",
    ])
    .default("Directory"),
  mountPath: z.string(),
  readOnly: z.boolean().default(true),
});

export const PersistenceSchema = z.object({
  name: z.string(),
  storageClassName: z.string().default("local-storage"),
  readOnly: z.boolean().default(true),
  storage: z.string(),
  hostPath: z.string(),
  mountPath: z.string(),
  nodeAffinityHostname: z.string(),
});

export const ImageSchema = z.object({
  repository: z.string(),
  tag: z.string(),
  pullPolicy: z.string().optional(),
});

export const LIMITS_DEFAULT = {
  cpu: "50m",
  memory: "64Mi",
} as const;

export const LimitsSchema = z.object({
  memory: z.string().default(LIMITS_DEFAULT.memory),
  cpu: z.string().default(LIMITS_DEFAULT.cpu),
});

export const STRATEGY_DEFAULTS = {
  type: "RollingUpdate",
} as const;

export const StrategySchema = z.object({
  type: z.enum(["Recreate", "RollingUpdate"]).default("RollingUpdate"),
});
