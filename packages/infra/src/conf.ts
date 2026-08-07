import * as pulumi from "@pulumi/pulumi";
import { parseVpnUsers } from "@jaritanet/vpn";
import * as z from "zod";
import { ConfSchema } from "./conf.schemas.ts";

const config = new pulumi.Config();

/**
 * Secrets nested inside structured config decrypt to ordinary strings.
 *
 * `getObject` hands the program plaintext — the `secure:` wrapper exists only
 * in the stack file, and the `[secret]` seen in a deploy's output is the engine
 * redacting its own stdout, not the value. So a secret can live beside the
 * thing that uses it rather than in a flat key at the root, and Zod can still
 * validate the whole block in one parse.
 *
 * What that buys is the reason the environment is gone: `pulumi up` from a
 * laptop needs a Pulumi login and nothing else. Assembling twenty variables by
 * hand meant one omission was not an error but an empty string, and an empty
 * hostname silently removes a service.
 */
const { data, error } = ConfSchema.safeParse({
  adminSshKey: config.get("adminSshKey"),
  bluesky: config.requireObject("bluesky"),
  cloudflare: config.requireObject("cloudflare"),
  edges: config.getObject("edges"),
  exits: config.getObject("exits"),
  fastmail: config.requireObject("fastmail"),
  gateway: config.getObject("gateway"),
  services: config.requireObject("services"),
  tailnet: config.getObject("tailnet"),
  traefik: config.requireObject("traefik"),
  ubuntuProToken: config.get("ubuntuProToken"),
  vpnEntryLabel: config.get("vpnEntryLabel"),
  vpnUsers: config.get("vpnUsers"),
  zones: config.requireObject("zones"),
});

if (error) {
  throw new Error(`Could not parse config:\n\n${z.prettifyError(error)}\n\n`);
}

export const conf = data;

// The parsed VPN roster (empty when unset — main.ts then falls back to a single
// implicit owner-admin so the multi-user path is exercised uniformly).
export const vpnUsers = conf.vpnUsers ? parseVpnUsers(conf.vpnUsers) : [];
