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

/**
 * Pod-level security context. Every field is optional and none is defaulted,
 * because setting one has consequences: `fsGroup` in particular switches on
 * kubelet volume ownership management, which walks and chowns the volume. On a
 * 2Ti media library backed by a `local` PV that is not a default anyone wants
 * to acquire by accident — so a service that only needs to run as a given uid
 * sets exactly that and nothing else.
 */
export const SecurityContextSchema = z.object({
  fsGroup: z.number().optional(),
  runAsGroup: z.number().optional(),
  runAsUser: z.number().optional(),
});
