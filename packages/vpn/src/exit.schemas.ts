import * as z from "zod";
import { LabelKey, Port } from "@jaritanet/k8s";

/**
 * A selectable egress exit node: an ss-rust server whose IP the traffic leaves
 * from. The whole point is the address it presents, so an exit is pinned to a
 * machine and dialled at that machine's own address.
 *
 * `nodeLabel` decides which machine egresses, the same argument the VPN entry
 * label and the file-server label make. Nothing here can apply it — a node
 * seeded from cloud-init has no connection in this program — so it is declared
 * as the node joins, by `SEED_NODE_LABELS` in `scripts/make-seed-drive`.
 *
 * `server` is where an entry dials the exit — its tailnet address, since every
 * gateway and edge is a tailnet member and the home node has no inbound port.
 * An address rather than a name because it resolves at the *entry* end of a
 * detour, where MagicDNS does not exist: the client's resolvers are all
 * tunnelled and the gateway's unbound knows nothing of the tailnet.
 *
 * It is **pinned, not stable**. A tailnet address survives reboots but not a
 * re-registration: sympathy's moved from `100.69.78.57` to `100.78.67.16` when
 * its identity left the DaemonSet's Secret for systemd state. Re-auth, node
 * deletion or state loss on an exit node does the same, and the failure is
 * quiet — the DaemonSet stays healthy and the profile stays valid while the
 * entry dials an address nobody answers on. So it is updated by hand, from
 * `kubectl get node <name> -o wide`, whenever that happens.
 *
 * Reading it from the Node's `InternalIP` would be self-correcting (a seeded
 * agent joins with `--node-ip=$(tailscale ip -4)`, so the value is already
 * there) and was deliberately not done: it makes every preview depend on that
 * Node object existing, which puts the *gateway's* deploy behind a home box
 * being in the cluster. On a cluster rebuild, where the gateway is the thing
 * being restored and the home node has not rejoined yet, that is the wrong
 * failure.
 *
 * `name` drives the picker tag (`exit-<name>`) and the resource names. `port`
 * is the host port on the exit node (pure plumbing); leave it unset and it is
 * derived deterministically from the name at deploy time. Only set it to
 * resolve a rare name-hash collision.
 */
export const ExitConfSchema = z.object({
  image: z.string().default("ghcr.io/shadowsocks/ssserver-rust:v1.24.0"),
  method: z.string().default("aes-256-gcm"),
  name: z.string(),
  nodeLabel: LabelKey,
  port: Port.optional(),
  server: z.ipv4(),
});
