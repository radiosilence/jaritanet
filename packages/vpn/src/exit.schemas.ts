import * as z from "zod";
import { Port } from "@jaritanet/k8s";

/**
 * A selectable egress exit node: an ss-rust server whose IP the traffic leaves
 * from. The whole point is the address it presents, so an exit is pinned to a
 * machine and dialled at that machine's own address.
 *
 * `nodeLabel` decides which machine egresses, the same argument the VPN entry
 * label and the file-server label make. Nothing here can apply it: a node
 * seeded from cloud-init has no connection in this program, so the label goes
 * on by hand when the node joins.
 *
 * `server` is where an entry dials the exit — its tailnet address, since every
 * gateway and edge is a tailnet member and the home node has no inbound port.
 * An address rather than a name because it resolves at the *entry* end of a
 * detour, where MagicDNS does not exist: the client's resolvers are all
 * tunnelled and the gateway's unbound knows nothing of the tailnet.
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
  nodeLabel: z.string(),
  port: Port.optional(),
  server: z.ipv4(),
});
