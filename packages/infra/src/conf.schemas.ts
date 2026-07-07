import * as z from "zod";
import { ServiceArgsSchema } from "./templates/service.schemas.ts";

export const CloudflareConfSchema = z.object({
  accountId: z.string(),
});

/**
 * Xray-core with VLESS-Vision-REALITY on the gateway VPS, sharing :443
 * with rathole. Unauthenticated connections (probes, browsers) are relayed
 * to `dest` so the box looks like an ordinary TLS site; authenticated
 * clients get proxied out to the internet as a censorship-resistant VPN.
 *
 * `serverName` is the SNI clients present and the domain the decoy pretends
 * to be — it must match the cert served at `dest`. `dest` defaults to the
 * local rathole https port (so the decoy is your own Traefik); point it at
 * an external site (e.g. "www.microsoft.com:443") to borrow someone else's.
 */
export const XrayConfSchema = z.object({
  dest: z.string().default("127.0.0.1:8443"),
  serverName: z.string(),
  version: z.string().default("v1.8.24"),
});

export const GatewayConfSchema = z.object({
  image: z.string().default("ubuntu-24.04"),
  location: z.string().default("nbg1"),
  ratholeVersion: z.string().default("v0.5.0"),
  serverType: z.string().default("cx23"),
  xray: XrayConfSchema.optional(),
});

export const TraefikConfSchema = z.object({
  acmeEmail: z.string(),
  chartVersion: z.string().default("34.3.0"),
});

export const ServiceConfSchema = z.object({
  args: ServiceArgsSchema,
  hostname: z.string().optional(),
});

export const ServicesMapSchema = z.record(z.string(), ServiceConfSchema);

const DnsModuleEnum = z.enum(["bluesky", "fastmail"]);

export const ZoneConfSchema = z.object({
  modules: z.array(DnsModuleEnum),
  name: z.string(),
  zoneId: z.string(),
});

export const ZonesConfSchema = z.array(ZoneConfSchema);

export const FastmailConfSchema = z.object({
  dkimDomain: z.string(),
  dkimSubdomain: z.string(),
  dmarcAggEmail: z.string(),
  dmarcPolicy: z.string(),
  dmarcSubdomain: z.string(),
  mxDomain: z.string(),
  spfDomain: z.string(),
});

export const BlueskyConfSchema = z.object({
  did: z.string(),
});

export const ConfSchema = z.object({
  bluesky: BlueskyConfSchema,
  cloudflare: CloudflareConfSchema,
  clusterDomain: z.string().default("cluster.local"),
  externalIp: z.string().optional(),
  fastmail: FastmailConfSchema,
  gateway: GatewayConfSchema.optional(),
  managedBy: z.string().default("jaritanet"),
  namespace: z.string().default("jaritanet"),
  services: ServicesMapSchema,
  traefik: TraefikConfSchema,
  zones: ZonesConfSchema,
});
