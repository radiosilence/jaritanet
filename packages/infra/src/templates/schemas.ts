import * as z from "zod";

export const HostVolumeSchema = z.object({
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
  name: z.string(),
  readOnly: z.boolean().default(true),
});

export const PersistenceSchema = z.object({
  hostPath: z.string(),
  mountPath: z.string(),
  name: z.string(),
  nodeAffinityHostname: z.string(),
  readOnly: z.boolean().default(true),
  storage: z.string(),
  storageClassName: z.string().default("local-storage"),
});

export const ImageSchema = z.object({
  pullPolicy: z.string().optional(),
  repository: z.string(),
  tag: z.string(),
});

export const LimitsSchema = z.object({
  cpu: z.string().default("50m"),
  memory: z.string().default("64Mi"),
});

export const StrategySchema = z.object({
  type: z.enum(["Recreate", "RollingUpdate"]).default("RollingUpdate"),
});

export const SecurityContextSchema = z.object({
  fsGroup: z.number().default(1000),
  runAsGroup: z.number().default(1000),
  runAsUser: z.number().default(1000),
});
