/**
 * The shapes `stack.ts` states its values in.
 *
 * Every schema describing a *component* lives with that component, in its own
 * package. What is left here is the part that only exists because it is
 * composed — a gateway is a Hetzner box plus transports plus a control plane,
 * and no single package owns that sentence.
 *
 * These stopped being a config parser when the config became TypeScript. What
 * they still do is the part a type cannot: apply defaults, and enforce
 * relationships — that `k3s.version` and `k3s.ciliumVersion` are a tested pair,
 * that no two REALITY server names share a first label.
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
import { MariastewConfSchema } from "@radiosilence/mariastew-pulumi";
import {
  McpGatewayConfSchema,
  McpSchema,
} from "@radiosilence/mcp-gateway-pulumi";
import { MetricsConfSchema } from "@jaritanet/metrics";
import {
  ExitConfSchema,
  HysteriaConfSchema,
  TailnetConfSchema,
  XrayConfSchema,
} from "@jaritanet/vpn";
import * as z from "zod";
import { Hostname, HostPort } from "@jaritanet/k8s";

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
