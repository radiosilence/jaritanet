import * as pulumi from "@pulumi/pulumi";
import { parseVpnUsers } from "@jaritanet/vpn";
import { EnvSchema } from "./env.schema.ts";

const config = new pulumi.Config();

/**
 * `ACME_EMAIL` in the environment is `acmeEmail` in the stack.
 *
 * Derived rather than mapped: a table of both spellings is one more thing to
 * keep in step, and the failure when it drifts is a value silently not found.
 * Environment variables are conventionally shouted; Pulumi config is not.
 */
const configKey = (name: string) =>
  name.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * Stack config first, environment second.
 *
 * The stack is the better home: `pulumi up` then works from a laptop with
 * nothing but a Pulumi login, rather than needing twenty variables assembled by
 * hand — where one omission is not an error but an empty string, and an empty
 * hostname silently removes a service.
 *
 * The environment stays as a fallback so CI keeps working while values move,
 * and so a value can be overridden for one run without touching the stack.
 */
const lookup = (name: string) =>
  config.get(configKey(name)) ?? process.env[name];

export const env = EnvSchema.parse(
  Object.fromEntries(
    Object.keys(EnvSchema.shape).map((key) => [key, lookup(key)]),
  ),
);

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
 * So the config names the value it wants and this resolves it as the config is
 * read — from the stack first, the environment second. Nothing rewrites the
 * file: substituting on disk would leave whatever was resolved at the time in
 * the working tree.
 *
 * An unset variable becomes an empty string, because that is what an absent
 * secret should mean.
 */
export function resolveEnvRefs<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Z0-9_]+)\}/g,
      (_match, name: string) => lookup(name) ?? "",
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
