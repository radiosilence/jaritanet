import { z } from "zod";

export const CloudflareConfSchema = z.object({
  /**
   * The Cloudflare account ID.
   */
  accountId: z.string(),
});

export type CloudflareConf = z.infer<typeof CloudflareConfSchema>;

export const TunnelConfSchema = z.object({
  /**
   * Cloudflare Tunnel Name
   */
  name: z.string(),
});

export type TunnelConf = z.infer<typeof TunnelConfSchema>;
