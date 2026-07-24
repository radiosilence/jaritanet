import * as z from "zod";

export const EnvSchema = z.object({
  CLOUDFLARE_API_TOKEN: z.string().min(1, "CLOUDFLARE_API_TOKEN is required"),
  DEPLOY_TOKEN: z.string().optional(),
  GITHUB_REPOSITORY: z.string().default("radiosilence/jaritanet"),
  HCLOUD_TOKEN: z.string().optional(),
  KUBE_API_PORT: z.string().min(1, "KUBE_API_PORT is required"),
  KUBE_HOST: z.string().min(1, "KUBE_HOST is required"),
  KUBE_TOKEN: z.string().min(1, "KUBE_TOKEN is required"),
  TS_AUTHKEY: z.string().optional(),

  // MCP gateway: GitHub OAuth app creds + login allowlist. GH_ prefix because
  // GitHub Actions reserves GITHUB_. Absent → the gateway stack is skipped.
  GH_CLIENT_ID: z.string().optional(),
  GH_CLIENT_SECRET: z.string().optional(),
  GH_ALLOWED: z.string().optional(),

  // Per-user VPN access (RBAC). One comma-separated list; a trailing `+` marks
  // an admin. Absent → single implicit owner-admin (see main.ts). Parsed by
  // parseVpnUsers below into a typed {name, role}[]; delivery is per-user.
  VPN_USERS: z.string().optional(),

  // sing-box profile delivery (Pulumi generates + ships the profile). All
  // optional — absent any of them, delivery is skipped. Telegram is optional
  // on top (notify only). Generic inputs get generic names; only the profile
  // slug is sing-box-specific.
  FILES_HOSTNAME: z.string().optional(),
  OLDBOY_HOST: z.string().optional(),
  OLDBOY_USER: z.string().default("jc"),
  SSH_PRIVATE_KEY: z.string().optional(),
  SINGBOX_SLUG: z.string().optional(),
  TAILNET_MAGICDNS_SUFFIX: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});

/**
 * A VPN identity and its access tier. `admin` gets hy2 + reality on every node,
 * all exits, and tailnet 100.x; `guest` gets reality only, direct egress, no
 * tailnet — enforced hard server-side (see xray.ts), not by profile shape.
 */
export const VpnUserSchema = z.object({
  name: z.string(),
  role: z.enum(["admin", "guest"]),
});
export type VpnUser = z.infer<typeof VpnUserSchema>;

// Names double as Xray client emails, hy2 usernames, and the per-user profile
// slug seed, so keep them to a filename-safe identifier charset.
const NAME_RE = /^[a-z][a-z0-9_-]*$/i;

/**
 * Parses the `VPN_USERS` secret ("jc+,guest1") into a typed user list. Splits on
 * comma, trims, and strips a trailing `+` to mark an admin (else guest). Empty
 * tokens (a stray trailing comma) are skipped. Throws on an invalid name or a
 * duplicate — a bad list should fail the deploy loudly, not silently drop a user.
 */
export function parseVpnUsers(raw: string): VpnUser[] {
  const users: VpnUser[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const isAdmin = trimmed.endsWith("+");
    const name = (isAdmin ? trimmed.slice(0, -1) : trimmed).trim();
    if (!NAME_RE.test(name)) {
      throw new Error(
        `VPN_USERS: invalid user name "${name}" — must match ${NAME_RE}`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`VPN_USERS: duplicate user name "${name}"`);
    }
    seen.add(name);
    users.push({ name, role: isAdmin ? "admin" : "guest" });
  }
  return users;
}
