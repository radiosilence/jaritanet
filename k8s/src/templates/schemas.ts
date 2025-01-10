import { z } from "zod";

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
export type HostVolumeSchema = z.infer<typeof HostVolumeSchema>;

export const PersistenceSchema = z.object({
  storageClassName: z.string().default("local-storage"),
  accessModes: z.array(z.string()).default(["ReadWriteOnce"]),
  storage: z.string(),
  localPath: z.string(),
  mountPath: z.string(),
  nodeAffinityHostname: z.string(),
});

export type Persistence = z.infer<typeof PersistenceSchema>;

export const ImageSchema = z.object({
  repository: z.string(),
  tag: z.string(),
  pullPolicy: z.string().optional(),
});

export type Image = z.infer<typeof ImageSchema>;

export const LimitsSchema = z
  .object({
    memory: z.string().default("64Mi"),
    cpu: z.string().default("50m"),
  })
  .default({});

export type Limits = z.infer<typeof LimitsSchema>;
