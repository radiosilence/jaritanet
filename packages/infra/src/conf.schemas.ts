/**
 * This stack's configuration surface.
 *
 * Every schema describing a *component* lives with that component, in its own
 * package. What is left here is the part that is genuinely jaritanet's: which
 * components this deployment runs, and the shapes that only exist because they
 * are composed — a gateway is a Hetzner box plus transports plus a control
 * plane, and no single package owns that sentence.
 *
 * Component schemas are re-exported rather than merely imported, so
 * `scripts/gen-schemas.ts` and the config in Pulumi.main.yaml keep describing
 * one surface instead of chasing six packages.
 */
import {
  BlueskyConfSchema,
  FastmailConfSchema,
  ZoneConfSchema,
  ZonesConfSchema,
} from "@jaritanet/dns";
import { K3sConfSchema } from "@jaritanet/hetzner";
import { SambaConfSchema, SyncthingConfSchema } from "@jaritanet/home";
import { TraefikConfSchema } from "@jaritanet/ingress";
import { ServiceArgsSchema } from "@jaritanet/k8s";
import { McpGatewayConfSchema, McpSchema } from "@jaritanet/mcp-gateway";
import {
  ExitConfSchema,
  HysteriaConfSchema,
  TailnetConfSchema,
  UnboundConfSchema,
  XrayConfSchema,
} from "@jaritanet/vpn";
import * as z from "zod";

export {
  BlueskyConfSchema,
  ExitConfSchema,
  FastmailConfSchema,
  HysteriaConfSchema,
  K3sConfSchema,
  McpGatewayConfSchema,
  McpSchema,
  SambaConfSchema,
  SyncthingConfSchema,
  TailnetConfSchema,
  TraefikConfSchema,
  UnboundConfSchema,
  XrayConfSchema,
  ZoneConfSchema,
  ZonesConfSchema,
};

export const CloudflareConfSchema = z.object({
  accountId: z.string(),
});

export const GatewayConfSchema = z.object({
  /**
   * Bump to reissue every VPN credential: REALITY keypair, shortId and per-user
   * UUIDs, and hysteria's obfs and per-admin passwords.
   *
   * Revocation needed a mechanism. Removing a user from VPN_USERS drops *their*
   * credential, but nothing reissued the shared ones, so a profile leaking —
   * the URL is unauthenticated and the whole credential set is in the body —
   * had no answer short of editing Pulumi state by hand. This is that answer:
   * one value, every secret behind it, and the new profiles delivered by the
   * run that changes it.
   *
   * Rotating the base slug (SINGBOX_SLUG) as well moves the URLs, but on its
   * own it only hides the new profile — the leaked credentials keep working
   * until this changes too.
   */
  credentialRotation: z.string().default("1"),
  hysteria: HysteriaConfSchema.optional(),
  /**
   * What the box is called — in Hetzner, and by default on the tailnet.
   *
   * Separate from the Pulumi resource name, which stays `gateway` so the state
   * mapping survives a rename. The machine can be called whatever it is; the
   * slot it fills is still "the gateway".
   */
  name: z.string().default("sympathy"),
  image: z.string().default("ubuntu-26.04"),
  k3s: K3sConfSchema.optional(),
  location: z.string().default("nbg1"),
  ratholeVersion: z.string().default("v0.5.0"),
  serverType: z.string().default("cx23"),
  tailnet: TailnetConfSchema.optional(),
  unbound: UnboundConfSchema.default({
    image: "docker.io/klutchell/unbound:v1.24.0",
  }),
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
  hysteria: HysteriaConfSchema.default({
    altPorts: [3478, 4500],
    port: 443,
    sni: "www.bing.com",
    image: "docker.io/tobyxdd/hysteria:v2.10.0",
  }),
  image: z.string().default("ubuntu-26.04"),
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

/**
 * The home node and what it serves — file shares, sync, media tooling.
 *
 * Absent until there is a machine: no block, no resources, and the stack is
 * unchanged. That is the point of it being optional rather than defaulted, as
 * a default would schedule a DaemonSet against a label no node carries and
 * report success while serving nothing.
 *
 * `nodeLabel` decides which machine serves files, so that is a property of the
 * machine rather than a hostname written down here — the same argument the VPN
 * entry label makes. Unlike that one it cannot be enforced from here: nothing
 * in this program can label the node, because reaching the home box over SSH is
 * exactly the coupling moving these services into the cluster removes. The
 * label is applied once, by hand, when the node joins.
 */
export const HomeConfSchema = z.object({
  nodeLabel: z.string().default("jaritanet.radiosilence.dev/file-node"),
  samba: SambaConfSchema.optional(),
  syncthing: SyncthingConfSchema.optional(),
});

export const ServiceConfSchema = z.object({
  args: ServiceArgsSchema,
  hostname: z.string().optional(),
});

export const ServicesMapSchema = z.record(z.string(), ServiceConfSchema);

/**
 * Where each user's sing-box profile is served from.
 *
 * Deliberately not on blit.cc: FortiGuard rates it "Other Adult Materials", so
 * a filtered network — exactly the network a VPN profile is wanted on — blocks
 * the device from fetching its own subscription.
 */
export const ProfilesConfSchema = z.object({
  hostname: z.string(),
  image: z.string(),
});

export const ConfSchema = z.object({
  bluesky: BlueskyConfSchema,
  cloudflare: CloudflareConfSchema,
  clusterDomain: z.string().default("cluster.local"),
  edges: z.array(EdgeConfSchema).default([]),
  exits: z.array(ExitConfSchema).default([]),
  externalIp: z.string().optional(),
  fastmail: FastmailConfSchema,
  gateway: GatewayConfSchema.optional(),
  home: HomeConfSchema.optional(),
  managedBy: z.string().default("jaritanet"),
  mcpGateway: McpGatewayConfSchema.optional(),
  namespace: z.string().default("jaritanet"),
  profiles: ProfilesConfSchema.optional(),
  services: ServicesMapSchema,
  traefik: TraefikConfSchema,
  zones: ZonesConfSchema,
});
