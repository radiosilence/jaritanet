import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { TailnetConfSchema } from "../conf.schemas.ts";

type Connection = {
  host: pulumi.Output<string>;
  privateKey: pulumi.Output<string>;
  user: string;
};

/**
 * Joins the gateway VPS to the tailnet so it can relay client traffic into
 * the mesh.
 *
 * The transports are connection-level proxies, not raw IP tunnels: a client
 * flow to 100.x arrives over hy2/reality and the VPS dials that address
 * itself, so the OS routes it out tailscale0 to the home nodes. That's why
 * no IP forwarding, NAT, or subnet-router advertisement is needed — being a
 * member is enough.
 *
 * `accept-routes=false` is load-bearing: a peer advertising an exit node or
 * routes must not be able to swallow the VPS default route, or the relay
 * (and every service riding it) goes dark. `--ssh=false` is explicit: the
 * gateway is managed purely by config and exposes no human SSH over the
 * tailnet (explicit rather than omitted so a re-run definitely clears it).
 *
 * `authKey` is an OAuth client secret (`tskey-client-...`, auth_keys scope +
 * the tag), used directly as the auth key — those don't hit the 90-day
 * expiry that raw auth keys do. OAuth-minted keys default to ephemeral, so
 * `ephemeral=false` is required to keep the relay node persistent.
 */
export function createTailscale(
  connection: Connection,
  server: hcloud.Server,
  tailnet: z.infer<typeof TailnetConfSchema>,
  authKey: pulumi.Output<string>,
) {
  return new command.remote.Command(
    "tailscale-up",
    {
      connection,
      create: pulumi.interpolate`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
tailscale up \
  --auth-key="${authKey}?ephemeral=false&preauthorized=true" \
  --hostname="${tailnet.hostname}" \
  --advertise-tags="${tailnet.tag}" \
  --accept-routes=false \
  --ssh=false`,
      // Not keyed on authKey: the node persists after first auth, so
      // re-running only matters when the command changes. Bump the version
      // to force a re-run (e.g. after rotating the key or changing flags).
      triggers: ["tailscale-v2", tailnet.hostname, tailnet.tag],
    },
    { dependsOn: [server] },
  );
}
