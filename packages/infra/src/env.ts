import { EnvSchema, parseVpnUsers } from "./env.schema.ts";

export const env = EnvSchema.parse(process.env);

// The parsed VPN roster (empty when VPN_USERS is unset — main.ts then falls back
// to a single implicit owner-admin so the multi-user path is exercised uniformly).
export const vpnUsers = env.VPN_USERS ? parseVpnUsers(env.VPN_USERS) : [];
