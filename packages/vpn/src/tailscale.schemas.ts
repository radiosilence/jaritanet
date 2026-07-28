import * as z from "zod";

/**
 * Joins a node to the tailnet so it can relay client traffic into the mesh.
 * Clients route 100.64.0.0/10 through the hy2/reality tunnel and the node dials
 * those addresses locally over tailscale0 — no IP forwarding or subnet routing,
 * the box just has to be a member. Enabled only when an auth key is also
 * present. `tag` disables key expiry and drives ACLs; reuse `tag:server` so
 * existing tagOwners/grants apply.
 */
export const TailnetConfSchema = z.object({
  hostname: z.string().default("jaritanet-gw"),
  image: z.string().default("ghcr.io/tailscale/tailscale:v1.98.9"),
  tag: z.string().default("tag:server"),
});
