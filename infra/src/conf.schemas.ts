import { z } from "zod";

export const CloudflareConfSchema = z.object({
  /**
   * The Cloudflare account ID.
   */
  accountId: z.string().describe("The Cloudflare account ID."),
});

export type CloudflareConf = z.infer<typeof CloudflareConfSchema>;

export const TunnelConfSchema = z.object({
  /**
   * Cloudflare Tunnel Name
   */
  name: z.string().describe("Cloudflare Tunnel Name."),
});

export type TunnelConf = z.infer<typeof TunnelConfSchema>;
