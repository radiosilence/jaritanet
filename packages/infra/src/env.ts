import { parseVpnUsers } from "@jaritanet/vpn";
import { EnvSchema } from "./env.schema.ts";

export const env = EnvSchema.parse(process.env);

// The parsed VPN roster (empty when VPN_USERS is unset — main.ts then falls back
// to a single implicit owner-admin so the multi-user path is exercised uniformly).
export const vpnUsers = env.VPN_USERS ? parseVpnUsers(env.VPN_USERS) : [];

/**
 * Resolves `${VAR}` references in stack config from the environment.
 *
 * Hostnames cannot live in this public repo, and they cannot come from
 * `EnvSchema` either: they sit inside `services`, a map, so injecting them would
 * need a name-to-variable mapping kept in step with the config by hand — which
 * drifts, and drifts silently, because a missing entry just yields an empty
 * hostname and `main.ts` skips a service with one of those.
 *
 * So the config names the variable it wants and this resolves it as the config
 * is read. Nothing rewrites the file: substituting on disk would leave whatever
 * the environment held at the time in the working tree, which locally is
 * nothing at all.
 *
 * An unset variable becomes an empty string, because that is what an absent
 * secret should mean.
 */
export function resolveEnvRefs<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Z0-9_]+)\}/g,
      (_match, name: string) => process.env[name] ?? "",
    ) as T;
  }
  if (Array.isArray(value)) return value.map(resolveEnvRefs) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveEnvRefs(v)]),
    ) as T;
  }
  return value;
}
