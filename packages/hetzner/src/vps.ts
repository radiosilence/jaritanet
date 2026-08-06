import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";

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
 * Triggers for a command that configures a server, alongside whatever else it
 * depends on.
 *
 * `dependsOn` only orders; it does not make a replaced server re-run anything.
 * A command triggered solely by its own config keeps its recorded success when
 * the box underneath it is rebuilt, so the new box comes up unconfigured while
 * the stack reports no drift — the worst shape a failure can take, because
 * nothing asks to be fixed. The 26.04 rebuild landed exactly there: patching
 * re-ran only because its token happened to change in the same update, and the
 * admin key and the network sysctls were never installed at all. A server's id
 * changes on replacement, so including it ties the command to the box it
 * actually configured.
 */
const serverTriggers = (
  server: hcloud.Server,
  ...rest: pulumi.Input<unknown>[]
) => [server.id, ...rest];

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
# Written is not applied: sshd takes the first AuthorizedKeysFile it obtains, so
# an uncommented directive ahead of the Include wins and leaves a drop-in that
# reads as installed while selecting nothing. Assert what the daemon resolves,
# the same reasoning createNetworkTuning and createAutomaticPatching follow.
# Read into a variable rather than piping to \`grep -q\`, whose early exit would
# fail the pipeline under pipefail on the very path that succeeded.
resolved=$(sshd -T | grep -i '^authorizedkeysfile ' || true)
case "$resolved" in
  *${keyFile}*) ;;
  *)
    rm -f ${dropIn}
    echo "sshd resolved '$resolved'; ${keyFile} did not take effect, rolled back" >&2
    exit 1
    ;;
esac
${reload}`,
      delete: `rm -f ${dropIn} ${keyFile}
${reload}`,
      triggers: serverTriggers(server, publicKey, "admin-ssh-v2"),
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
 * Makes security patches actually take effect, rather than merely arrive.
 *
 * Cloud images enable `unattended-upgrades` for the security pocket, so patches
 * install on their own — and then sit there. `Automatic-Reboot` ships false, so
 * a new kernel is downloaded, installed, and never booted. The gateway was found
 * running 6.8.0-117 with 6.8.0-136 on disk and `/run/reboot-required` set, which
 * is the default configuration working exactly as documented and achieving
 * nothing. A window is the half that was missing.
 *
 * Livepatch is the other half, and they are not substitutes. A window still
 * leaves the interval between a CVE landing and 04:00, which is where local
 * privilege escalation lives; livepatch closes that to hours by patching the
 * running kernel. It in turn does not cover userspace, or fixes that restructure
 * kernel data, and it only supports a kernel for so long before demanding a
 * reboot — so the window is also what keeps livepatch able to keep working.
 *
 * Every box takes the same 04:00 window, which is deliberate while the fleet is
 * a gateway and a home node: they serve different things, so one shared outage
 * minute beats two staggered ones. It stops being right once edges exist —
 * every VPN entry rebooting together is an outage rather than a blip, and the
 * time wants to vary per box at that point.
 *
 * The token is interpolated into the script and the whole command marked
 * secret. Passing it as `environment` is the tidier shape and does not work:
 * that uses SSH's `setenv`, which sshd refuses unless the server lists the
 * variable in `AcceptEnv`, and Ubuntu ships accepting only `LANG` and `LC_*`.
 * Configuring that would mean an sshd change to deliver a token whose purpose
 * is configuring the box — so the value goes in the script, and `pulumi.secret`
 * keeps it encrypted in state rather than stored in the clear.
 */
export function createAutomaticPatching(
  name: string,
  connection: SshConnection,
  server: hcloud.Server,
  proToken?: pulumi.Input<string>,
) {
  return new command.remote.Command(
    `${name}-automatic-patching`,
    {
      connection,
      create: pulumi.secret(pulumi.interpolate`set -euo pipefail
# Same wait the k3s install opens with, and needed here for the same reason:
# Ubuntu runs unattended-upgrades once cloud-init finishes and holds the dpkg
# lock for minutes, and \`pro attach\` shells out to apt. This command depends
# only on the server, so on a freshly created box it races both — and since
# changing the image replaces the server, a fresh box is the normal case rather
# than the first-run one. Under \`set -e\` losing that race is a failed deploy.
cloud-init status --wait >/dev/null 2>&1 || true
mkdir -p /etc/apt/apt.conf.d
printf 'DPkg::Lock::Timeout "600";\\n' > /etc/apt/apt.conf.d/99-lock-timeout

cat > /etc/apt/apt.conf.d/51unattended-upgrades-local << 'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
# Written is not applied: apt merges apt.conf.d in lexical order, so assert the
# value that actually resolves rather than the file that was just written.
apt-config dump | grep -q 'Unattended-Upgrade::Automatic-Reboot "true"'

UBUNTU_PRO_TOKEN='${pulumi.output(proToken ?? "")}'
if [ -n "$UBUNTU_PRO_TOKEN" ]; then
  # Attaching twice is an error, so this is guarded rather than retried. The
  # explicit enable is why attach does not auto-enable: livepatch is what this
  # is for, and the rest of the entitlements should be a decision.
  #
  # The guard makes rotating the token a no-op: the box is already attached, so
  # a new one is never presented. Rotation means \`pro detach --assume-yes\` on
  # the box first, and is rare enough not to be worth detaching on every trigger
  # change to support.
  pro api u.pro.status.is_attached.v1 | grep -q '"is_attached": *true' \\
    || pro attach "$UBUNTU_PRO_TOKEN" --no-auto-enable
  pro enable livepatch --assume-yes || true
  # Same reasoning as the sysctls: enable can report success on a kernel
  # livepatch does not cover, and a security control believed to be on is worse
  # than one known to be off.
  pro status --format=json | python3 -c "
import json, sys
services = {s['name']: s['status'] for s in json.load(sys.stdin).get('services', [])}
sys.exit(0 if services.get('livepatch') == 'enabled' else 1)
"
fi`),
      triggers: serverTriggers(
        server,
        pulumi.output(proToken ?? ""),
        "patching-v1",
      ),
    },
    { dependsOn: [server] },
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
      triggers: serverTriggers(server, "bbr-fq-udp-buffers-v2"),
    },
    { dependsOn: [server] },
  );
}
