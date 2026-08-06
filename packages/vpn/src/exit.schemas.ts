import * as z from "zod";
import { LabelKey, Port } from "@jaritanet/k8s";

/**
 * A selectable egress exit node: an ss-rust server whose IP the traffic leaves
 * from. The whole point is the address it presents, so an exit is pinned to a
 * machine and dialled at that machine's own address.
 *
 * `nodeLabel` decides which machine egresses, the same argument the VPN entry
 * label and the file-server label make — and it is the whole mechanism, not
 * bookkeeping. The DaemonSet controller watches Nodes, so marking one schedules
 * the exit onto it in about a second and unmarking it tears the pod down; k8s
 * does the rest and nothing here has to.
 *
 * That also makes the label the single piece of state the exit depends on, and
 * the only one whose absence nothing reports: an unlabelled node means zero pods
 * on a cluster that looks perfectly healthy. So `node` names the machine to put
 * it on and this program applies it, over the Kubernetes API rather than SSH —
 * reach comes from cluster membership, the same property that carries k3s
 * upgrades to a box Pulumi never created. Hand-labelling is then a way to move
 * an exit for an afternoon, not the thing holding it in place.
 *
 * `server` is where an entry dials the exit — its tailnet address, since the
 * home node has no inbound port. An address rather than a name because it
 * resolves at the *entry* end of a detour, where MagicDNS does not exist: the
 * client's resolvers are all tunnelled and the gateway's unbound knows nothing
 * of the tailnet.
 *
 * That makes a tailnet a hard requirement of the exit axis, not a nicety: an
 * entry's membership is gated on `tailnet.authKey`, and an entry without one
 * reaches no exit at all while the profile goes on offering every pair. Asserted
 * in main rather than left to be discovered.
 *
 * An exit can only run on a **cluster node**, since it is a DaemonSet. Edges are
 * standalone boxes with systemd transports and never join, so the machines that
 * can be an entry and the machines that can host an exit are disjoint sets today
 * — in both directions, as a NATed home node can never be an entry. Giving an
 * edge an exit needs either cluster membership or a `-systemd` exit beside the
 * other transports.
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
  node: z.string(),
  nodeLabel: LabelKey,
  port: Port.optional(),
  server: z.ipv4(),
});
