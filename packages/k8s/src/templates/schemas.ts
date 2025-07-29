import * as z from "zod";

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

export const LimitsSchema = z.object({
  cpu: z.string().default("50m"),
  memory: z.string().default("64Mi"),
});

export const StrategySchema = z.object({
  type: z.enum(["Recreate", "RollingUpdate"]).default("RollingUpdate"),
});

export const SecurityContextSchema = z.object({
  runAsUser: z.number().default(1000),
  runAsGroup: z.number().default(1000),
  fsGroup: z.number().default(1000),
});
