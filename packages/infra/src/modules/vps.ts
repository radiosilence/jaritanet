import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import type * as pulumi from "@pulumi/pulumi";

/** SSH connection to a provisioned Hetzner VPS. */
export type Connection = {
  host: pulumi.Output<string>;
  privateKey: pulumi.Output<string>;
  user: string;
};

/**
 * Resource-name prefix for a node. Empty name = the primary gateway, keeping
 * its original resource names so Pulumi doesn't replace the live box; edges and
 * their transports pass a name and get prefixed names.
 */
export const resourcePrefix = (name: string) => (name ? `${name}-` : "");

/** An inbound hcloud firewall rule open to the whole internet (v4 + v6). */
export const inboundRule = (
  description: string,
  port: number | string,
  protocol: "tcp" | "udp" = "tcp",
) => ({
  description,
  direction: "in",
  port: String(port),
  protocol,
  sourceIps: ["0.0.0.0/0", "::/0"],
});

/**
 * Network sysctls the transports need, over SSH so the box is never rebuilt.
 *
 * BBR + fq: default cubic collapses throughput on packet loss; BBR holds the
 * pipe open across the lossy links the relayed/VPN traffic rides over.
 *
 * The UDP buffer ceilings are what make Hysteria2 fast. quic-go asks for a
 * multi-megabyte receive buffer and logs a warning when the kernel refuses,
 * which it does above `net.core.rmem_max` — Ubuntu ships that at 208KB, small
 * enough that a fast link spends its time dropping datagrams the userspace
 * QUIC stack never got to read. 16MB is the value hysteria's own documentation
 * gives. This has to be set on the *node*: the transports run with
 * `hostNetwork`, so they share these sysctls and setting them in a pod spec
 * would configure a namespace nothing runs in.
 */
export function createNetworkTuning(
  name: string,
  connection: Connection,
  server: hcloud.Server,
) {
  return new command.remote.Command(
    `${name}-network-tuning`,
    {
      connection,
      create: `set -euo pipefail
cat > /etc/sysctl.d/99-network-tuning.conf << 'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
EOF
sysctl --system
# Written is not applied: assert the values the transports actually depend on,
# rather than trusting that sysctl.d was read in the order we assumed.
test "$(sysctl -n net.core.rmem_max)" = 16777216
test "$(sysctl -n net.core.wmem_max)" = 16777216`,
      triggers: ["bbr-fq-udp-buffers-v2"],
    },
    { dependsOn: [server] },
  );
}
