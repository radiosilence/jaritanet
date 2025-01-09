import { z } from "zod";

export const VolumeSchema = z.object({
  hostPath: z.string(),
  mountPath: z.string(),
  rw: z.boolean().optional(),
});
export type Volume = z.infer<typeof VolumeSchema>;

export const ImageSchema = z.object({
  repository: z.string(),
  tag: z.string(),
  pullPolicy: z.string().optional(),
});

export type Image = z.infer<typeof ImageSchema>;

export const PortsSchema = z
  .object({
    http: z.number(),
  })
  .optional();

export type Ports = z.infer<typeof PortsSchema>;
