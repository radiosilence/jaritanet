import * as z from "zod";

export const EnvSchema = z.object({
  CLOUDFLARE_API_TOKEN: z.string().min(1, "CLOUDFLARE_API_TOKEN is required"),
  DEPLOY_TOKEN: z.string().optional(),
  GITHUB_REPOSITORY: z.string().default("radiosilence/jaritanet"),
  HCLOUD_TOKEN: z.string().optional(),
  TS_AUTHKEY: z.string().optional(),

  // Tailnet policy-as-code. Absent, the policy stays hand-managed in the admin
  // console and the Pulumi resource is never created — same idiom as
  // TS_AUTHKEY gating the relay. Needs an OAuth client with the `policy_file`
  // scope; see README.
  TS_OAUTH_CLIENT_ID: z.string().optional(),
  TS_OAUTH_CLIENT_SECRET: z.string().optional(),
  TS_TAILNET: z.string().optional(),

  // MCP gateway: GitHub OAuth app creds + login allowlist. GH_ prefix because
  // GitHub Actions reserves GITHUB_. Absent → the gateway stack is skipped.
  GH_CLIENT_ID: z.string().optional(),
  GH_CLIENT_SECRET: z.string().optional(),
  GH_ALLOWED: z.string().optional(),

  // Per-user VPN access (RBAC). One comma-separated list; a trailing `+` marks
  // an admin. Absent → single implicit owner-admin (see main.ts). Parsed by
  // `parseVpnUsers` from @jaritanet/vpn into a typed {name, role}[].
  VPN_USERS: z.string().optional(),

  // sing-box profile delivery (Pulumi generates + ships the profile). All
  // optional — absent any of them, delivery is skipped. Telegram is optional
  // on top (notify only). Generic inputs get generic names; only the profile
  // slug is sing-box-specific.
  SINGBOX_SLUG: z.string().optional(),
  TAILNET_MAGICDNS_SUFFIX: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});
