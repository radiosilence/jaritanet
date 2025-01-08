import { z } from "zod";

export const CloudflareConfSchema = z.object({
  accountId: z.string(),
});

export type CloudflareConf = z.infer<typeof CloudflareConfSchema>;

export const TunnelConfSchema = z.object({
  name: z.string(),
});

export type TunnelConf = z.infer<typeof TunnelConfSchema>;
