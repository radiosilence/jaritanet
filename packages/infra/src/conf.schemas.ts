import * as z from "zod";
import { ServiceArgsSchema } from "./templates/service.schemas.ts";

export const CloudflareConfSchema = z.object({
  accountId: z.string(),
});

/**
 * Xray-core (VLESS-Vision-REALITY) on the gateway VPS, sharing :443 with
 * rathole. Traffic that doesn't match a client is relayed to `dest`;
 * matched clients are proxied out.
 *
 * `serverName` is the SNI clients present and must match the TLS cert served
 * at `dest`. `dest` defaults to the local rathole https port; point it at an
 * external "host:port" to use a different backend.
 */
export const XrayConfSchema = z.object({
  dest: z.string().default("127.0.0.1:8443"),
  serverName: z.string(),
  version: z.string().default("v26.3.27"),
});

/**
 * Hysteria2 (QUIC/UDP) on the gateway VPS. Loss-tolerant congestion
 * control keeps it smooth on lossy/jittery links where the TCP-based
 * Reality path melts down; Salamander obfuscation hides the QUIC from DPI.
 * `sni` is cosmetic (clients trust the self-signed cert via insecure).
 */
export const HysteriaConfSchema = z.object({
  port: z.number().default(443),
  sni: z.string().default("www.bing.com"),
});

/**
 * Joins the gateway VPS to the tailnet so it can relay client traffic into
 * the mesh. Clients route 100.64.0.0/10 through the hy2/reality tunnel and
 * the VPS dials those addresses locally over tailscale0 — no IP forwarding
 * or subnet routing, the box just has to be a member. Enabled only when a
 * TS_AUTHKEY is also present. `tag` disables key expiry and drives ACLs;
 * reuse `tag:server` so existing tagOwners/grants apply.
 */
export const TailnetConfSchema = z.object({
  hostname: z.string().default("jaritanet-gw"),
  tag: z.string().default("tag:server"),
});

export const GatewayConfSchema = z.object({
  hysteria: HysteriaConfSchema.optional(),
  image: z.string().default("ubuntu-24.04"),
  location: z.string().default("nbg1"),
  ratholeVersion: z.string().default("v0.5.0"),
  serverType: z.string().default("cx23"),
  tailnet: TailnetConfSchema.optional(),
  xray: XrayConfSchema.optional(),
});

/**
 * A standalone VPN edge box — hy2 + REALITY + tailnet relay, no reverse proxy.
 *
 * Unlike the primary gateway it fronts no home services, which is exactly why
 * its REALITY decoy can point at a real EXTERNAL site: there's no own-site to
 * break by forwarding probe traffic away. `name` drives everything — the
 * `<name>.<zone>` A record clients connect to, the `jaritanet-<name>` tailnet
 * hostname, and the per-instance Pulumi resource names.
 */
export const EdgeConfSchema = z.object({
  hysteria: HysteriaConfSchema.default({ port: 443, sni: "www.bing.com" }),
  image: z.string().default("ubuntu-24.04"),
  location: z.string().default("hel1"),
  name: z.string(),
  reality: z
    .object({
      dest: z.string().default("www.microsoft.com:443"),
      serverName: z.string().default("www.microsoft.com"),
    })
    .default({
      dest: "www.microsoft.com:443",
      serverName: "www.microsoft.com",
    }),
  serverType: z.string().default("cx23"),
  zone: z.string().default("radiosilence.dev"),
});

export const TraefikConfSchema = z.object({
  acmeEmail: z.string(),
  chartVersion: z.string().default("41.0.2"),
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
  edges: z.array(EdgeConfSchema).default([]),
  externalIp: z.string().optional(),
  fastmail: FastmailConfSchema,
  gateway: GatewayConfSchema.optional(),
  managedBy: z.string().default("jaritanet"),
  namespace: z.string().default("jaritanet"),
  services: ServicesMapSchema,
  traefik: TraefikConfSchema,
  zones: ZonesConfSchema,
});
