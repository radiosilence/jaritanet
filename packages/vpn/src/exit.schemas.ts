import * as z from "zod";

/**
 * A selectable egress exit node: rathole client + ss-rust, substrate-agnostic
 * (k8s now; a cloud-init VPS later). Traffic egresses via the exit's own IP.
 *
 * Reached through the EXISTING rathole tunnel, not the tailnet: the exit's
 * ss-rust port is surfaced on the rathole gateway's loopback (`127.0.0.1:<port>`)
 * via a rathole service entry, exactly like the Reality decoy `dest`. The
 * client's ss outbound dials `127.0.0.1:<port>` through that gateway (detour),
 * and because a detour resolves the inner address at the gateway end, it hits
 * the gateway's rathole loopback for this exit.
 *
 * Exits route via the **primary** gateway specifically — it's the only node
 * that runs rathole (edges run hy2/reality only). So the exit detour is pinned
 * to the primary, independent of which entry `entry-select` picks for direct
 * traffic. When more rathole-running gateways exist, `port` must be identical
 * across them so one exit outbound works via any of them.
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
