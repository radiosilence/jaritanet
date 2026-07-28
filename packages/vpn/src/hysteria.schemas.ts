import * as z from "zod";

/**
 * Hysteria2 (QUIC/UDP) on the entry node. Loss-tolerant congestion control
 * keeps it smooth on lossy/jittery links where the TCP-based Reality path melts
 * down; Salamander obfuscation hides the QUIC from DPI. `sni` is cosmetic
 * (clients trust the self-signed cert via insecure).
 *
 * `altPorts` are additional listeners, and the point is that no single UDP
 * port survives every network. Inspecting middleboxes (FortiGate et al) block
 * QUIC on 443 as a matter of course — they cannot deep-inspect it, so they
 * force browsers back to TCP TLS. The alternates are ports a restrictive
 * network has to permit on purpose: 3478 is STUN, open wherever WhatsApp and
 * Teams calls work, and 4500 is IPsec NAT-T, open wherever staff VPNs work.
 * Regimes that block VoIP (Egypt, UAE, Saudi) invert it exactly — 3478 dies
 * first there and 443 lives — which is the argument for serving all of them
 * and letting the client's urltest find the survivor. Keep the list short:
 * each port is another probe on every switch and another row in the picker.
 */
export const HysteriaConfSchema = z.object({
  altPorts: z.array(z.number()).default([3478, 4500]),
  // Not the project's own GHCR org, which publishes nothing: this is the
  // image hysteria's install docs point at, on a maintainer's Docker Hub
  // account. A weaker supply-chain position, accepted knowingly.
  image: z.string().default("docker.io/tobyxdd/hysteria:v2.10.0"),
  port: z.number().default(443),
  sni: z.string().default("www.bing.com"),
});
