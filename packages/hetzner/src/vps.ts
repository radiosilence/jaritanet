import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import type * as pulumi from "@pulumi/pulumi";

/** SSH connection to a provisioned Hetzner VPS. */
export type SshConnection = {
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
 * Break-glass SSH access for a human, over SSH so the box is never rebuilt.
 *
 * Everything routine is reachable with kubectl alone — host files, host
 * networking, even `systemctl`, via a privileged pod with `hostPID` and
 * `nsenter`. The case that isn't is k3s failing to come up: no API server means
 * no kubectl, which means no privileged pod, which is exactly when getting onto
 * the box is the only remaining move. The mechanism for adding a key is the
 * thing that is broken at that moment, so the key has to already be there.
 *
 * Not via the server's `sshKeys` or `userData`: Hetzner applies both only at
 * creation, so changing either replaces the box — a new IP, a new REALITY
 * keypair, and every client profile rotating.
 *
 * The key lands in its own file rather than root's `authorized_keys`, which is
 * the one Pulumi authenticates with: a mistake in the shared file locks the
 * deploy out of the box it is deploying to, with no way back in. `sshd -t` runs
 * before anything is reloaded and the drop-in is removed if it fails, so a bad
 * config fails this command rather than the daemon.
 */
export function createAdminSshAccess(
  name: string,
  connection: SshConnection,
  server: hcloud.Server,
  publicKey: string,
) {
  const dropIn = "/etc/ssh/sshd_config.d/60-jaritanet-admin.conf";
  const keyFile = "/etc/ssh/admin_authorized_keys";

  // Socket-activated sshd (the Ubuntu 24.04 default) starts a fresh process per
  // connection and so reads the config anyway; where ssh.service holds port 22
  // the running daemon has the old config loaded and must be told. Starting
  // ssh.service unconditionally would fight ssh.socket for the port.
  const reload = `systemctl is-active --quiet ssh.service && systemctl reload ssh.service || true`;

  return new command.remote.Command(
    `${name}-admin-ssh`,
    {
      connection,
      create: `set -euo pipefail
install -m 0600 -o root -g root /dev/null ${keyFile}
cat > ${keyFile} << 'KEY_EOF'
${publicKey}
KEY_EOF
# Root's own authorized_keys stays first and untouched — it is the key this
# command is running over.
cat > ${dropIn} << 'EOF'
AuthorizedKeysFile .ssh/authorized_keys ${keyFile}
EOF
if ! sshd -t; then
  rm -f ${dropIn}
  echo "sshd rejected the admin drop-in; rolled back" >&2
  exit 1
fi
${reload}`,
      delete: `rm -f ${dropIn} ${keyFile}
${reload}`,
      triggers: [publicKey, "admin-ssh-v1"],
    },
    {
      dependsOn: [server],
      // A trigger change replaces this resource, and the default order is
      // create-then-delete: the new key would be written and then the old
      // resource's delete would remove both files, leaving no key at all.
      // Rotating the key has to delete first.
      deleteBeforeReplace: true,
    },
  );
}

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
  connection: SshConnection,
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
