import { z } from "zod/v4";

export const CloudflareConfSchema = z.object({
  accountId: z.string(),
});

export const TunnelConfSchema = z.object({
  name: z.string(),
});

// K8s schemas
export const CloudflaredArgsSchema = z.object({
  image: z.string(),
  replicas: z.number().default(1),
  resources: z
    .object({
      limits: z.object({
        memory: z.string().default("128Mi"),
        cpu: z.string().default("250m"),
      }),
    })
    .default({
      limits: {
        memory: "128Mi",
        cpu: "250m",
      },
    }),
});

export const ServiceArgsSchema = z.object({
  image: z.object({
    repository: z.string(),
    tag: z.string(),
    pullPolicy: z.string().optional(),
  }),
  replicas: z.number().default(1),
  env: z.record(z.string(), z.string()).default({}),
  httpPort: z.number().default(80),
  ports: z.array(z.tuple([z.number(), z.number()])).default([]),
  hostVolumes: z.array(z.any()).default([]),
  persistence: z.array(z.any()).default([]),
  healthCheck: z.any().optional(),
  strategy: z.any().optional(),
  securityContext: z.any().optional(),
  limits: z.any().optional(),
});

export const CloudflaredConfSchema = z.object({
  name: z.string(),
  args: CloudflaredArgsSchema,
});

export const ServiceConfSchema = z.object({
  name: z.string(),
  hostname: z.string(),
  proxied: z.boolean().default(true),
  args: ServiceArgsSchema,
});

export const ServicesMapSchema = z.record(
  z.string(),
  ServiceConfSchema.omit({ name: true }),
);

export const ServiceSchema = z.object({
  hostname: z.string(),
  proxied: z.boolean(),
});

// Routes schemas
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

const DnsModuleEnum = z.enum(["bluesky", "fastmail"]);

export const ZoneConfSchema = z.object({
  zoneId: z.string().describe("The Cloudflare ID of the zone."),
  name: z.string().describe("The name of the zone."),
  modules: z.array(DnsModuleEnum).describe("DNS modules to apply."),
});

export const ZonesConfSchema = z.array(ZoneConfSchema);

// Consolidated schema
export const InfraConfSchema = z.object({
  // Core infra
  cloudflare: CloudflareConfSchema,
  tunnel: TunnelConfSchema,

  // K8s
  cloudflared: CloudflaredConfSchema,
  services: ServicesMapSchema,
  namespace: z.string().default("jaritanet"),
  managedBy: z.string().default("jaritanet"),
  clusterDomain: z.string().default("cluster.local"),

  // Routes
  zones: ZonesConfSchema,
  bluesky: BlueskyConfSchema,
  fastmail: FastmailConfSchema,
});
