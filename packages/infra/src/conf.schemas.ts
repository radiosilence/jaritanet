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
  /**
   * Edits DNS: the A records, and the TXT records Traefik writes to answer
   * Let's Encrypt's DNS-01 challenge. The `cloudflare:apiToken` provider key
   * holds the same value — that one configures the provider, this one is
   * handed to Traefik, and nothing can read the provider's copy back out.
   */
  apiToken: z.string().min(1),
});

/**
 * The tailnet itself, as distinct from the relay that joins it.
 *
 * `gateway.tailnet` describes a *daemon* — which image, what to call the node.
 * This describes the account that daemon authenticates against, which is why
 * the edges and the profile server read it too. Neither is a sub-case of the
 * other, so they are separate blocks rather than one with optional halves.
 */
export const TailnetAccountConfSchema = z.object({
  /** Joins the gateway, every edge, and the in-cluster relay. */
  authKey: z.string().optional(),
  /**
   * The `*.ts.net` suffix. Not a secret — it is in the certificate
   * transparency logs the moment MagicDNS issues a cert.
   */
  magicdnsSuffix: z.string().optional(),
  /** Tailnet name for policy-as-code, e.g. `example.com` or `tail1234.ts.net`. */
  name: z.string().optional(),
  /**
   * Policy-as-code credentials. Absent, the policy stays hand-managed in the
   * admin console and the Pulumi resource is never created. Needs the
   * `policy_file` scope; see README.
   */
  oauth: z
    .object({
      clientId: z.string(),
      clientSecret: z.string(),
    })
    .optional(),
});

export const GatewayConfSchema = z.object({
  /**
   * Bump to reissue every VPN credential: REALITY keypair, shortId and per-user
   * UUIDs, and hysteria's obfs and per-admin passwords.
   *
   * Revocation needed a mechanism. Removing a user from `vpnUsers` drops *their*
   * credential, but nothing reissued the shared ones, so a profile leaking —
   * the URL is unauthenticated and the whole credential set is in the body —
   * had no answer short of editing Pulumi state by hand. This is that answer:
   * one value, every secret behind it, and the new profiles delivered by the
   * run that changes it.
   *
   * The profile slug rotates off this value too, which moves the URLs — but a
   * moved URL only hides the new profile. The leaked credentials keep working
   * until the secrets behind them are reissued, which is what this does.
   */
  credentialRotation: z.string().default("1"),
  /**
   * Creates the VPS, and its presence is what decides there is a gateway at
   * all — absent, the stack falls back to `externalIp`. The `hcloud:token`
   * provider key holds the same value for the provider's own use.
   */
  hcloudToken: z.string().optional(),
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
  /**
   * Notifies on change, with every user's profile URL. Absent → no message,
   * and the URLs are read from `pulumi stack output` instead.
   */
  telegram: z
    .object({
      botToken: z.string(),
      chatId: z.string(),
    })
    .optional(),
});

export const ConfSchema = z.object({
  /**
   * Break-glass admin key, installed on the gateway and every edge over SSH
   * rather than at creation, so rotating it never replaces a box. Absent → no
   * resource. Not a secret: it is the public half.
   *
   * Shape-checked because the failure is silent and badly timed — a mangled
   * key installs cleanly and is only discovered to be useless when k3s is down
   * and SSH is the last way in.
   */
  adminSshKey: z
    .string()
    .refine(
      (key) => key === "" || /^(ssh|ecdsa|sk)-\S+\s+\S+/.test(key),
      "adminSshKey must be an OpenSSH public key line (`ssh-ed25519 AAAA…`)",
    )
    .optional(),
  bluesky: BlueskyConfSchema,
  cloudflare: CloudflareConfSchema,
  clusterDomain: z.string().default("cluster.local"),
  edges: z.array(EdgeConfSchema).default([]),
  exits: z.array(ExitConfSchema).default([]),
  fastmail: FastmailConfSchema,
  gateway: GatewayConfSchema.optional(),
  home: HomeConfSchema.optional(),
  managedBy: z.string().default("jaritanet"),
  /**
   * `github` is this deployment's, not the component's: the gateway needs some
   * OAuth app, and which one is a fact about who runs it. Extended here so the
   * package keeps knowing nothing about jaritanet.
   */
  mcpGateway: McpGatewayConfSchema.extend({
    github: z
      .object({
        /** Login allowlist, comma-separated. Not a secret — these are usernames. */
        allowed: z.string().default(""),
        clientId: z.string(),
        clientSecret: z.string(),
      })
      .optional(),
  }).optional(),
  namespace: z.string().default("jaritanet"),
  profiles: ProfilesConfSchema.optional(),
  services: ServicesMapSchema,
  tailnet: TailnetAccountConfSchema.default({}),
  traefik: TraefikConfSchema,
  /**
   * Ubuntu Pro, for livepatch on the gateway and every edge. Free for personal
   * use on up to five machines. Absent → the reboot window is still configured
   * and only livepatch is skipped, because a box that boots its patches is the
   * baseline and livepatch is the improvement on it.
   */
  ubuntuProToken: z.string().optional(),
  /**
   * The node label key marking a machine as a VPN entry. One value reaches both
   * the command that labels the node and the nodeSelector on every transport
   * DaemonSet, so those cannot disagree — which is the whole reason it is read
   * once, here, and passed down rather than defaulted in each place.
   *
   * Required rather than defaulted for the same reason. A wrong-but-present
   * value is caught by the next preview, since relabelling a node and
   * rescheduling the transports is a visible diff. An *absent* one would have
   * to fall back to something, and a fallback that disagrees with the live
   * node's label schedules zero pods onto a cluster reporting perfectly
   * healthy — the VPN goes dark with nothing anywhere reporting a fault.
   */
  vpnEntryLabel: z
    .string()
    .regex(
      /^([a-z0-9]([-a-z0-9]*[a-z0-9])?\.)*[a-z0-9]([-a-z0-9]*[a-z0-9])?\/[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/,
      "vpnEntryLabel must be a prefixed Kubernetes label key (<dns-subdomain>/<name>)",
    ),
  /**
   * Per-user VPN access (RBAC). One comma-separated list; a trailing `+` marks
   * an admin. Absent → single implicit owner-admin (see main.ts). Parsed by
   * `parseVpnUsers` from @jaritanet/vpn into a typed {name, role}[].
   */
  vpnUsers: z.string().optional(),
  zones: ZonesConfSchema,
});
