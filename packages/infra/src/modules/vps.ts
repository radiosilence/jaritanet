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
 * Enable BBR congestion control + fq qdisc over SSH. Default cubic collapses
 * throughput on packet loss; BBR holds the pipe open across the lossy links the
 * relayed/VPN traffic rides over. Applied over SSH so the box is never rebuilt.
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
      create: `cat > /etc/sysctl.d/99-network-tuning.conf << 'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
sysctl --system`,
      triggers: ["bbr-fq-v1"],
    },
    { dependsOn: [server] },
  );
}
