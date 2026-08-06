import * as z from "zod";

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
 * Parses a roster ("jc+,guest1") into a typed user list. Splits on
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
        `invalid VPN user name "${name}" — must match ${NAME_RE}`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`duplicate VPN user name "${name}"`);
    }
    seen.add(name);
    users.push({ name, role: isAdmin ? "admin" : "guest" });
  }
  return users;
}
