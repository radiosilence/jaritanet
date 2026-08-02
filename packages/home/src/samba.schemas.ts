import * as z from "zod";

/**
 * One exported share. `hostPath` is a path on the node, not a PVC: the media
 * lives on a disk physically attached to one machine, so a claim that could be
 * satisfied anywhere would be describing something that is not true.
 *
 * `readOnly` defaults to true and is the reason this is worth containerising at
 * all — a read-only export needs no uid impersonation on writes and no
 * ownership rewriting, which is where containerised samba usually turns nasty.
 */
export const SambaShareSchema = z.object({
  name: z.string(),
  hostPath: z.string(),
  readOnly: z.boolean().default(true),
});

/**
 * Anonymous, read-only SMB over the host's network.
 *
 * `hostNetwork` is not a shortcut here, it is the whole design. smbd has to bind
 * every one of the node's real interfaces — the LAN, and `tailscale0` — because
 * that is how clients reach it today and the point of the move is to change how
 * the share is *configured*, not how it is *reached*. On the pod network it
 * would be unreachable from the tailnet entirely: the pod CIDR is not routed
 * over the mesh, and making it so would hairpin cluster traffic through the
 * gateway.
 *
 * `allowedNetworks` becomes `hosts allow`. Kept even though a NetworkPolicy can
 * express the same thing, because a hostNetwork pod bypasses the CNI dataplane —
 * so the policy engine is not in this path and smbd's own check is the control
 * that actually runs.
 */
export const SambaConfSchema = z.object({
  image: z
    .string()
    .default("ghcr.io/servercontainers/samba:smbd-only-a4.21.4-s3.0.1-r0"),
  /** `hosts allow` — the tailnet and the LAN, never the internet. */
  allowedNetworks: z
    .array(z.string())
    .default(["100.64.0.0/10", "192.168.0.0/16", "127.0.0.1"]),
  /**
   * The account unknown users are mapped onto. It must own the media, or every
   * read fails — which is why this is named rather than defaulted to `nobody`.
   */
  guestAccount: z.string(),
  /** uid/gid the guest account resolves to on the node. */
  guestUid: z.number().default(1000),
  guestGid: z.number().default(1000),
  serverString: z.string().default("jaritanet"),
  shares: z.array(SambaShareSchema).min(1),
  workgroup: z.string().default("WORKGROUP"),
});
