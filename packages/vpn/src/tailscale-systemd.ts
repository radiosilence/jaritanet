import { readFileSync } from "node:fs";
import { join } from "node:path";
import { remotePreamble } from "@jaritanet/remote";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { TailnetConfSchema } from "./tailscale.schemas.ts";
import { resourcePrefix, type SshConnection, type SystemdOpts } from "./ssh.ts";
import { TAILSCALE_VERSION } from "./versions.ts";

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
 * `accept-routes=false` is the starting point: a peer advertising routes must
 * not be able to swallow the VPS default route, or the relay (and every service
 * riding it) goes dark. A cluster node then has it turned on by
 * createTailnetRoutes, to reach the other nodes' pods, which is safe because
 * the policy approves routes only inside the pod network and only from the
 * cluster's tag. `--ssh=false` is explicit: the gateway is managed purely by
 * config and exposes no human SSH over the tailnet.
 *
 * `--reset` because those prefs change after this runs. Without it a re-run
 * refuses, since `tailscale up` demands every non-default pref be restated; with
 * it the run returns the node to exactly these flags, and on a cluster node
 * createTailnetRoutes re-asserts its own within 30 seconds.
 *
 * `authKey` is an OAuth client secret (`tskey-client-...`, auth_keys scope +
 * the tag), used directly as the auth key — those don't hit the 90-day
 * expiry that raw auth keys do. OAuth-minted keys default to ephemeral, so
 * `ephemeral=false` is required to keep the relay node persistent.
 *
 * That persistence is why `api` exists. A rebuilt box registers as a new
 * device while the old one still holds the hostname, so Tailscale names the new
 * one `<hostname>-1`, and anything addressing the node by MagicDNS name reaches
 * the dead machine. With `api` (an OAuth client with `devices:core` write),
 * the node is identified by the id its own tailscaled reports, every other
 * device this tag registered under the same hostname is deleted, and the node
 * is renamed to the hostname. Nothing here needs the old box to be reachable.
 *
 * Both steps run after `up` and are replaced with the machine, so they run once
 * per box. Run against a node that already holds its name they only read, so
 * adding them to a live node changes nothing on it and needs only read access;
 * write access matters on the deploy that rebuilds the box, which fails here,
 * before anything is configured with the name, if the client lacks it. Every
 * input of a local command is a trigger, so rotating the client re-runs the
 * claim, which is harmless for the same reason. The returned resource is the
 * claim when there is one, so dependents wait for the name, not only for `up`.
 */
export function createTailscaleSystemd(
  connection: SshConnection,
  // reference means nothing to it.
  tailnet: z.infer<typeof TailnetConfSchema>,
  authKey: pulumi.Output<string>,
  { name = "", dependsOn = [], replaceWith = [] }: SystemdOpts = {},
  api?: {
    clientId: pulumi.Input<string>;
    clientSecret: pulumi.Input<string>;
  },
) {
  const p = resourcePrefix(name);

  // The flags below are appended here, so a key that already carries them
  // produces `preauthorized=true?ephemeral=false` and tailscale refuses to
  // parse it. Stripping is cheap; the failure is not, because it leaves the box
  // off the tailnet — which is now what pod networking rides on.
  const bareKey = pulumi.output(authKey).apply((k) => k.split("?")[0]);

  // Pinned to the same release as the container image, so a security fix the
  // updater picks up reaches the hosts too; the install script alone leaves a
  // host on whatever was current when it was built. Separate from `up` so a
  // version bump restarts tailscaled without resetting the node's prefs.
  const install = new command.remote.Command(
    `${p}tailscale-install`,
    {
      connection,
      create: `${remotePreamble}
export DEBIAN_FRONTEND=noninteractive
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
apt-get update -qq
apt-get install -y -qq "tailscale=${TAILSCALE_VERSION}"`,
      triggers: [`v${TAILSCALE_VERSION}`],
    },
    { dependsOn, replaceWith },
  );

  const up = new command.remote.Command(
    `${p}tailscale-up`,
    {
      connection,
      create: pulumi.interpolate`${remotePreamble}
export DEBIAN_FRONTEND=noninteractive
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
tailscale up --reset \
  --auth-key="${bareKey}?ephemeral=false&preauthorized=true" \
  --hostname="${tailnet.hostname}" \
  --advertise-tags="${tailnet.tag}" \
  --accept-routes=false \
  --ssh=false`,
      // Not keyed on authKey: the node persists after first auth, so
      // re-running only matters when the command changes. Bump the version
      // to force a re-run (e.g. after rotating the key or changing flags).
      triggers: ["tailscale-v2", tailnet.hostname, tailnet.tag],
    },
    { dependsOn: [install], replaceWith },
  );

  if (!api) return up;

  const self = new command.remote.Command(
    `${p}tailscale-self`,
    {
      connection,
      create: `tailscale status --json --peers=false | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["ID"])'`,
    },
    { dependsOn: [up], replaceWith },
  );

  // Piped in rather than named, for the reason notifyProfileUrls gives.
  const script = readFileSync(
    join(import.meta.dirname, "..", "scripts", "claim-tailnet-name.ts"),
    "utf8",
  );

  return new command.local.Command(
    `${p}tailscale-name`,
    {
      create: "node --input-type=module-typescript",
      stdin: script,
      environment: {
        TAILNET_OAUTH_CLIENT_ID: api.clientId,
        TAILNET_OAUTH_CLIENT_SECRET: api.clientSecret,
        TAILNET_SELF: self.stdout.apply((s) => s.trim()),
        TAILNET_HOSTNAME: tailnet.hostname,
        TAILNET_TAG: tailnet.tag,
      },
    },
    { dependsOn: [self], replaceWith },
  );
}
