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

  // The node label key marking a machine as a VPN entry. One value reaches both
  // the command that labels the node and the nodeSelector on every transport
  // DaemonSet, so those cannot disagree — which is the whole reason it is read
  // once, here, and passed down rather than defaulted in each place.
  //
  // Required rather than defaulted for the same reason. A wrong-but-present
  // value is caught by the next preview, since relabelling a node and
  // rescheduling the transports is a visible diff. An *absent* one would have
  // to fall back to something, and a fallback that disagrees with the live
  // node's label schedules zero pods onto a cluster reporting perfectly
  // healthy — the VPN goes dark with nothing anywhere reporting a fault.
  // Failing here costs a red deploy before a single resource is touched.
  VPN_ENTRY_LABEL: z
    .string()
    .regex(
      /^([a-z0-9]([-a-z0-9]*[a-z0-9])?\.)*[a-z0-9]([-a-z0-9]*[a-z0-9])?\/[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/,
      "VPN_ENTRY_LABEL must be a prefixed Kubernetes label key (<dns-subdomain>/<name>)",
    ),

  // sing-box profile delivery (Pulumi generates + ships the profile). All
  // optional — absent any of them, delivery is skipped. Telegram is optional
  // on top (notify only). Generic inputs get generic names; only the profile
  // slug is sing-box-specific.
  SINGBOX_SLUG: z.string().optional(),
  TAILNET_MAGICDNS_SUFFIX: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});
