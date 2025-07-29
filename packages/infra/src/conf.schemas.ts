import * as z from "zod";

export const CloudflareConfSchema = z.object({
  accountId: z.string(),
});

export const TunnelConfSchema = z.object({
  name: z.string(),
});

export const InfraConfSchema = z.object({
  cloudflare: CloudflareConfSchema,
  tunnel: TunnelConfSchema,
});
