import * as crypto from "node:crypto";
import type * as pulumi from "@pulumi/pulumi";

/**
 * Marks a node as an entry point for the VPN transports.
 *
 * The DaemonSets carrying xray, hysteria, tailscale and unbound select on this
 * rather than on a hostname, so which machine serves an entry is a property of
 * that machine. When `lady` joins the cluster, or an edge does, giving it an
 * entry is a label on the node — not another module and not a config list here.
 * The label is applied by whoever owns the node (see gateway.ts).
 */
export const VPN_ENTRY_LABEL = "jaritanet.dev/vpn-entry";

/**
 * The name a REALITY SNI is known by in the client picker: `www.google.co.uk`
 * → `google`. Outbound tags have to be unique, so schemas that accept a list of
 * SNIs reject one whose labels collide rather than emit a broken profile.
 */
export const sniLabel = (sni: string) =>
  sni.replace(/^www\./, "").split(".")[0];

/**
 * Derives a REALITY x25519 keypair from 32 bytes of seed, in xray's format.
 *
 * The keypair has to be *derived* rather than generated, because generating one
 * in the program would mint a new key on every run — replacing the inbound and
 * invalidating every client profile each deploy. Feed it a `random.RandomBytes`
 * and the value persists in state, so the key is stable until deliberately
 * rotated.
 *
 * X25519 private keys are 32 raw bytes. Node will not take them bare, so they
 * are wrapped in the fixed PKCS8 prefix; the public half is then derived rather
 * than stored, which means the two can never disagree.
 *
 * The tradeoff this accepts: today `xray x25519` mints the key on the box and
 * the private half never leaves it. Deriving it here puts it in Pulumi state
 * instead — worse in that the key now exists somewhere other than the machine
 * using it, better in that xray becomes an ordinary pod with no on-box state.
 */
export const realityKeypair = (seed: Buffer) => {
  const PKCS8_X25519_PREFIX = Buffer.from(
    "302e020100300506032b656e04220420",
    "hex",
  );
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicRaw = crypto
    .createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .subarray(-32);
  return {
    privateKey: seed.toString("base64url"),
    publicKey: publicRaw.toString("base64url"),
  };
};

/**
 * sha256 hex digest of an Output string. Used as a `triggers` value so a
 * command/pod only re-runs when the rendered content it depends on changes.
 */
export const sha256hex = (
  input: pulumi.Output<string>,
): pulumi.Output<string> =>
  input.apply((s) => crypto.createHash("sha256").update(s).digest("hex"));
