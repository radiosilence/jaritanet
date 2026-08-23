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
import { AuthConfSchema as AuthComponentConfSchema } from "@jaritanet/auth";
import { K3sConfSchema } from "@jaritanet/hetzner";
import { SambaConfSchema, SyncthingConfSchema } from "@jaritanet/home";
import { TraefikConfSchema } from "@jaritanet/ingress";
import { ServiceArgsSchema } from "@jaritanet/k8s";
import { MariastewConfSchema } from "@jaritanet/mariastew";
import { McpGatewayConfSchema, McpSchema } from "@jaritanet/mcp-gateway";
import { MetricsConfSchema } from "@jaritanet/metrics";
import {
  ExitConfSchema,
  HysteriaConfSchema,
  TailnetConfSchema,
  XrayConfSchema,
} from "@jaritanet/vpn";
import * as z from "zod";
import { Hostname, HostPort, LabelKey } from "@jaritanet/k8s";

export {
  BlueskyConfSchema,
  ExitConfSchema,
  FastmailConfSchema,
  HysteriaConfSchema,
  K3sConfSchema,
  MariastewConfSchema,
  McpGatewayConfSchema,
  McpSchema,
  MetricsConfSchema,
  SambaConfSchema,
  SyncthingConfSchema,
  TailnetConfSchema,
  TraefikConfSchema,
  XrayConfSchema,
  ZoneConfSchema,
  ZonesConfSchema,
};

export const CloudflareConfSchema = z.object({
  accountId: z
    .string()
    .regex(/^[0-9a-f]{32}$/, "must be a 32-character Cloudflare account id"),
  /**
   * Edits DNS: the A records, and the TXT records Traefik writes to answer
   * Let's Encrypt's DNS-01 challenge. The `cloudflare:apiToken` provider key
   * holds the same value — that one configures the provider, this one is
   * handed to Traefik, and nothing can read the provider's copy back out.
   */
  apiToken: z.string().min(1),
});

/**
 * A Telegram bot for notifications, shared by whatever wants to send one.
 *
 * Its own schema rather than inline on a single service field because it now
 * has more than one consumer — see `ConfSchema.telegram`.
 */
export const TelegramConfSchema = z.object({
  botToken: z.string(),
  chatId: z
    .string()
    .regex(/^-?\d+$/, "must be a Telegram chat id (an integer)"),
});

/**
 * The tailnet itself, as distinct from the relay that joins it.
 *
 * `gateway.tailnet` describes a *daemon* — what to call the node and which tag
 * it advertises. This describes the account that daemon authenticates against,
 * which is why the edges and the profile server read it too. Neither is a
 * sub-case of the other, so they are separate blocks rather than one with
 * optional halves.
 */
export const TailnetAccountConfSchema = z.object({
  /** Joins the gateway, every edge, and the in-cluster relay. */
  authKey: z.string().optional(),
  /**
   * The `*.ts.net` suffix. Not a secret — it is in the certificate
   * transparency logs the moment MagicDNS issues a cert.
   */
  magicdnsSuffix: Hostname.optional(),
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
  /**
   * Who may apply the fleet's tags. Not derivable: Tailscale identities appear
   * nowhere else in config, and `traefik.acmeEmail` happening to hold the same
   * address is a coincidence rather than a relationship.
   */
  tagOwners: z.array(z.string()).default([]),
  /**
   * Tags advertised by nodes this stack does not provision — a bare-metal node
   * joined from a cloud-init seed, or CI. Tags for nodes Pulumi does create are
   * derived from what it tells them to advertise, so listing those here is
   * redundant rather than harmful.
   *
   * A tag missing from the union is not a cosmetic problem: a node cannot
   * advertise a tag the policy does not define, so it fails to join.
   */
  extraTags: z.array(z.string()).default([]),
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
  }),
  image: z.string().default("ubuntu-26.04"),
  location: z.string().default("hel1"),
  name: z.string(),
  reality: z
    .object({
      dest: HostPort.default("www.microsoft.com:443"),
      serverName: Hostname.default("www.microsoft.com"),
    })
    .default({
      dest: "www.microsoft.com:443",
      serverName: "www.microsoft.com",
    }),
  serverType: z.string().default("cx23"),
  zone: Hostname.default("radiosilence.dev"),
});

/**
 * Which machine serves files.
 *
 * A property of the machine rather than a hostname written down here — the same
 * argument the VPN entry label makes. Unlike that one it cannot be enforced from
 * here: nothing in this program can label the node, because reaching the home
 * box over SSH is exactly the coupling moving these services into the cluster
 * removes. The label arrives with the node, from `scripts/make-seed-drive`.
 *
 * Per service rather than on a block wrapping several, because which node
 * serves a share was always a fact about that share. A samba on lady and a
 * syncthing somewhere else is a sentence the config can now say.
 */
const FileNodeLabel = LabelKey.default("jaritanet.radiosilence.dev/file-node");

/**
 * Empty rather than absent is how a service says "built, but not published" —
 * it gets its workload and no DNS record and no route.
 */
const PublishedHostname = Hostname.or(z.literal("")).optional();

/**
 * A workload this deployment runs, tagged by what kind of thing it is.
 *
 * `kind` is what replaced four top-level blocks — `mcpGateway`, `home.samba`,
 * `home.syncthing`, `profiles` — each of which had its own construction call
 * and its own hand-rolled copy of "find the zone, make an A record, make an
 * IngressRoute". Publishing is the one thing every workload has in common, so
 * it happens once (see services.ts) rather than four times with four subtly
 * different zone lookups.
 *
 * A kind exists only for behaviour the config cannot express: rendering
 * `smb.conf`, standing up Hydra and Postgres, hashing a routing table into a
 * pod annotation. Anything that is just a container with disks is `web` and
 * needs no module at all — navidrome is 2Ti of media, a pinned uid and two
 * volumes, and it has never needed one. That is why there is no navidrome kind
 * and why the composition here stops at a tagged union rather than growing
 * into a hierarchy.
 *
 * Strict, all the way down. `navidrome.args.nodeSelector` sat in the stack file
 * doing nothing for months because Zod strips unknown keys in silence and the
 * generated JSON schema allowed them — the pinning it looked like it was doing
 * actually came from `nodeAffinityHostname` on the volumes. A key nobody reads
 * should be a red preview, not a comment that lies.
 */
export const ServiceConfSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("web"),
      args: ServiceArgsSchema,
      hostname: PublishedHostname,
    })
    .describe("A container behind Traefik — the default for anything ordinary"),
  SambaConfSchema.extend({
    kind: z.literal("samba"),
    nodeLabel: FileNodeLabel,
  }).strict(),
  SyncthingConfSchema.extend({
    kind: z.literal("syncthing"),
    nodeLabel: FileNodeLabel,
  }).strict(),
  // No `github` block: the gateway had its own OAuth app while it was the
  // login provider, and is an ordinary client of `auth` now. Which upstream
  // vouches for anyone is a single fact, at the top level, read once.
  McpGatewayConfSchema.extend({ kind: z.literal("mcp-gateway") }).strict(),
  z
    .strictObject({
      kind: z.literal("singbox-profiles"),
      /**
       * Where each user's sing-box profile is served from.
       *
       * Deliberately not on blit.cc: FortiGuard rates it "Other Adult
       * Materials", so a filtered network — exactly the network a VPN profile is
       * wanted on — blocks the device from fetching its own subscription.
       */
      hostname: Hostname,
      image: z.string(),
    })
    .describe("The per-user sing-box subscription server"),
  MariastewConfSchema.extend({
    kind: z.literal("mariastew"),
    /**
     * Runs where the disks are, pinned by the same label as the other file
     * services — the roots it writes to are hostPaths on that machine.
     */
    nodeLabel: FileNodeLabel,
  }).strict(),
  // One kind rather than four services: a store, two collectors and a
  // dashboard, wired to each other by names none of them configures. See
  // MetricsConfSchema.
  MetricsConfSchema.extend({ kind: z.literal("metrics") }).strict(),
]);

export const ServicesMapSchema = z.record(z.string(), ServiceConfSchema);

/**
 * The identity provider, and the OAuth app it authenticates people against.
 *
 * The app is this deployment's rather than the component's — it needs *some*
 * upstream, and which one is a fact about who runs it — so it is extended on
 * here exactly as the MCP gateway's is, and the package keeps knowing nothing
 * about jaritanet.
 *
 * `clientId` and `allowed` stay plain deliberately. Marking `allowed` secret
 * makes Pulumi redact the literal string from all output, which mangles every
 * path containing it.
 */
export const AuthConfSchema = AuthComponentConfSchema.extend({
  github: z
    .object({
      allowed: z.string().default(""),
      clientId: z.string(),
      clientSecret: z.string(),
    })
    .optional(),
}).strict();

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
  /**
   * Top level, beside `traefik`, and for the same reason: not because there is
   * only one of it — there is only one navidrome — but because it is the same
   * kind of thing. Traefik cannot be a service because it is what publishes
   * them; this cannot because it is what authenticates for them. Every service
   * depends on it and it depends on none of them.
   *
   * It still emits a hostname and a route, but that makes it a thing with an
   * address rather than a thing the cluster exists to serve.
   */
  auth: AuthConfSchema.optional(),
  bluesky: BlueskyConfSchema,
  cloudflare: CloudflareConfSchema,
  clusterDomain: z.string().default("cluster.local"),
  edges: z.array(EdgeConfSchema).default([]),
  exits: z.array(ExitConfSchema).default([]),
  fastmail: FastmailConfSchema,
  gateway: GatewayConfSchema.optional(),
  managedBy: z.string().default("jaritanet"),
  namespace: z.string().default("jaritanet"),
  /**
   * Everything this deployment runs in the cluster, keyed by name.
   *
   * The rule that decides what belongs here rather than at the top level: if it
   * is a workload, it is a service. What is left above is the part that is not
   * one — the accounts and DNS facts (`cloudflare`, `zones`, `tailnet`,
   * `fastmail`, `bluesky`), the machines (`gateway`, `edges`, `exits`), and
   * `traefik`, which cannot be a service because it is the thing that publishes
   * them.
   */
  services: ServicesMapSchema,
  tailnet: TailnetAccountConfSchema.default({ extraTags: [], tagOwners: [] }),
  /**
   * Two consumers — the sing-box profile server on change, and mariastew when
   * a download finishes — so it is a shared account rather than either one's
   * setting. Absent means neither notifies, which both treat as normal rather
   * than as an error.
   */
  telegram: TelegramConfSchema.optional(),
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
  vpnEntryLabel: LabelKey,
  /**
   * Per-user VPN access (RBAC). One comma-separated list; a trailing `+` marks
   * an admin. Absent → single implicit owner-admin (see main.ts). Parsed by
   * `parseVpnUsers` from @jaritanet/vpn into a typed {name, role}[].
   */
  vpnUsers: z.string().optional(),
  zones: ZonesConfSchema,
});
