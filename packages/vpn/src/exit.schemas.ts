import * as z from "zod";

/**
 * A selectable egress exit node: an ss-rust server whose IP the traffic leaves
 * from. Substrate-agnostic (k8s now; a cloud-init VPS later).
 *
 * The client's ss outbound dials `127.0.0.1:<port>` and detours through the
 * primary gateway. A detour resolves the inner address at the far end, so the
 * port has to exist on the primary's loopback — which is why `port` is fixed
 * per exit rather than allocated, and why exits pin to the primary rather than
 * following whichever entry `entry-select` picks for direct traffic.
 *
 * What binds that loopback port is currently unresolved: the reverse tunnel
 * that did it was removed when the cluster moved onto the gateway itself.
 *
 * `name` is the only field you normally set — it drives the picker tag
 * (`exit-<name>`) and the resource names. `port` is the gateway loopback port
 * (pure plumbing); leave it unset and it's derived deterministically from the
 * name at deploy time. Only set it to resolve a rare name-hash collision.
 */
export const ExitConfSchema = z.object({
  image: z.string().default("ghcr.io/shadowsocks/ssserver-rust:v1.24.0"),
  method: z.string().default("aes-256-gcm"),
  name: z.string(),
  port: z.number().optional(),
  substrate: z.enum(["k8s"]).default("k8s"),
});
