import { z } from "zod/v4";

export const ServiceSchema = z.object({
  service: z.string(),
  hostname: z.string(),
  proxied: z.boolean(),
});

const DnsModuleEnum = z.enum(["bluesky", "fastmail"]);

export const CloudflareConfSchema = z.object({
  accountId: z.string().describe("Cloudflare account ID."),
});

export const FastmailConfSchema = z.object({
  mxDomain: z.string(),
  dkimDomain: z.string(),
  dkimSubdomain: z.string(),
  dmarcSubdomain: z.string(),
  dmarcAggEmail: z.string(),
  dmarcPolicy: z.string(),
  spfDomain: z.string(),
});

export const BlueskyConfSchema = z.object({
  did: z
    .string()
    .describe(
      "Bluesky requires a DID to be set in the DNS records for authentication.",
    ),
});

export const ServiceStackConfSchema = z.object({
  path: z.string(),
  stack: z.string().optional(),
});

export const ServiceStacksConfSchema = z.array(ServiceStackConfSchema);

export const LegacyServiceConfSchema = z
  .object({
    hostname: z.string().describe("Record name for the service."),
    service: z.string().describe("Internal service URL."),
  })
  .describe(
    "Configuration for a tunneled service. @deprecated In favor of `ServiceOutput`.",
  );

export const ZoneConfSchema = z.object({
  zoneId: z.string().describe("The Cloudflare ID of the zone."),
  name: z.string().describe("The name of the zone."),
  modules: z.array(DnsModuleEnum).describe("DNS modules to apply."),
});

export const ZonesConfSchema = z.array(ZoneConfSchema);

export const RoutesConfSchema = z.object({
  serviceStacks: ServiceStacksConfSchema,
  zones: ZonesConfSchema,
  cloudflare: CloudflareConfSchema,
  bluesky: BlueskyConfSchema,
  fastmail: FastmailConfSchema,
  infraStackPath: z.string().default("radiosilence/jaritanet"),
});
