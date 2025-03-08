import { z } from "zod";

export const CloudflareConfSchema = z.object({
  /**
   * The Cloudflare account ID.
   */
  accountId: z.string().describe("The Cloudflare account ID."),
});

export const TunnelConfSchema = z.object({
  /**
   * Cloudflare Tunnel Name
   */
  name: z.string().describe("Cloudflare Tunnel Name."),
});

export const InfraConfSchema = z.object({
  /**
   * The Cloudflare configuration.
   */
  cloudflare: CloudflareConfSchema,

  /**
   * The Cloudflare tunnel configuration.
   */
  tunnel: TunnelConfSchema,
});
