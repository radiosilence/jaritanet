import { remotePreamble } from "@jaritanet/remote";
import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import { createHash } from "node:crypto";

/** SSH connection to a provisioned Hetzner VPS. */
export type SshConnection = {
  host: pulumi.Output<string>;
  privateKey: pulumi.Output<string>;
  user: string;
};

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
 *
 * The other commands that configure a box (k3s, tailscaled, the `-systemd`
 * transports, the VPN entry label) are tied to it with the `replaceWith`
 * resource option instead, which has the same effect on a rebuild. The three
 * commands here keep the id trigger because moving them would change their
 * triggers and re-run them on the next deploy, for no change in behaviour.
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
 * nothing. Rebooting is the half that was missing.
 *
 * The `-updates` pocket is allowed alongside security. Left to the default it is
 * never installed at all: the gateway was found with 55 packages from it
 * pending, among them a kernel, systemd and AppArmor, waiting for someone to run
 * apt by hand. Taking them as they are published, with the same reboot, is the
 * safer of the two ways they would otherwise arrive.
 *
 * Livepatch is the other half, and they are not substitutes. Rebooting still
 * leaves the interval between a CVE landing and the next reboot, which is where local
 * privilege escalation lives; livepatch closes that to hours by patching the
 * running kernel. It in turn does not cover userspace, or fixes that restructure
 * kernel data, and it only supports a kernel for so long before demanding a
 * reboot — so rebooting is also what keeps livepatch able to keep working.
 *
 * The box checks every two hours and reboots as soon as an install needs it,
 * rather than at a fixed time. Stock apt refreshes its lists at a random point
 * in a twelve-hour window and upgrades once a day, and a nightly window adds up
 * to another day on top, so a fix published in the morning could take two days
 * to be running. The `APT::Periodic` values are `always` because they are
 * intervals in days, checked against stamp files: a timer firing more often
 * than they allow does nothing. The cost is a reboot of a minute or two at an
 * unpredictable hour, a few times a week, which a VPN client rides out by
 * reconnecting. Home nodes keep the 04:00 window `scripts/make-seed-drive`
 * gives them, since nothing reaches them from the internet.
 *
 * Each box upgrades at its own minute past every second hour, derived from its
 * name, so the gateway and the edges do not all reboot into the same release
 * together and leave a client no entry to fail over to. The timers are not
 * `Persistent`: stock apt's are, and restarting one on a new schedule would
 * run the missed slot at once, rebooting the box in the middle of the deploy
 * that changed it. A deploy that still overlaps a run which installs a kernel
 * loses the API server for a minute or two and is re-run.
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
  const upgradeMinute =
    10 +
    (Number.parseInt(
      createHash("sha256").update(name).digest("hex").slice(0, 8),
      16,
    ) %
      50);
  return new command.remote.Command(
    `${name}-automatic-patching`,
    {
      connection,
      // The preamble earns its place here in particular: `pro attach` shells
      // out to apt, and this command depends only on the server, so on a
      // freshly created box it races cloud-init and the dpkg lock both. Under
      // `set -e` losing that race is a failed deploy, and since changing the
      // image replaces the server, a fresh box is the normal case rather than
      // the first-run one.
      create: pulumi.secret(pulumi.interpolate`${remotePreamble}

cat > /etc/apt/apt.conf.d/51unattended-upgrades-local << 'EOF'
APT::Periodic::Update-Package-Lists "always";
APT::Periodic::Download-Upgradeable-Packages "always";
APT::Periodic::Unattended-Upgrade "always";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "now";
Unattended-Upgrade::Allowed-Origins { "\${distro_id}:\${distro_codename}-updates"; };
EOF
# Upgrade at least ten minutes after the lists refresh, so each run sees fresh
# lists.
mkdir -p /etc/systemd/system/apt-daily.timer.d /etc/systemd/system/apt-daily-upgrade.timer.d
cat > /etc/systemd/system/apt-daily.timer.d/50-often.conf << 'EOF'
[Timer]
OnCalendar=
OnCalendar=*-*-* 00/2:00
RandomizedDelaySec=5m
Persistent=false
EOF
cat > /etc/systemd/system/apt-daily-upgrade.timer.d/50-often.conf << 'EOF'
[Timer]
OnCalendar=
OnCalendar=*-*-* 00/2:${String(upgradeMinute).padStart(2, "0")}
RandomizedDelaySec=0
Persistent=false
EOF
systemctl daemon-reload
systemctl restart apt-daily.timer apt-daily-upgrade.timer
# Written is not applied: apt merges apt.conf.d in lexical order, so assert the
# values that actually resolve rather than the file that was just written. A
# list is appended to across files, so the origin joins the defaults rather than
# replacing them. Read into a variable, since \`grep -q\` exiting early would
# fail the pipeline under pipefail.
resolved=$(apt-config dump)
case "$resolved" in
  *'Unattended-Upgrade::Automatic-Reboot "true"'*) ;;
  *) echo "Automatic-Reboot did not resolve to true" >&2; exit 1 ;;
esac
case "$resolved" in
  *'Unattended-Upgrade::Automatic-Reboot-Time "now"'*) ;;
  *) echo "Automatic-Reboot-Time did not resolve to now" >&2; exit 1 ;;
esac
case "$resolved" in
  *'APT::Periodic::Unattended-Upgrade "always"'*) ;;
  *) echo "APT::Periodic::Unattended-Upgrade did not resolve to always" >&2; exit 1 ;;
esac
case "$resolved" in
  *'Allowed-Origins:: "\${distro_id}:\${distro_codename}-updates"'*) ;;
  *) echo "the -updates origin did not resolve" >&2; exit 1 ;;
esac

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
  # esm-apps carries security updates for \`universe\`, which is otherwise
  # unsupported entirely; esm-infra is inert on a current LTS and enabled now
  # because the year it starts mattering is not one anyone will remember.
  pro enable esm-infra esm-apps --assume-yes || true
  # Same reasoning as the sysctls: enable can report success on a kernel
  # livepatch does not cover, and a security control believed to be on is worse
  # than one known to be off. Livepatch patches only Canonical's kernels, so on
  # the mainline kernel (createMainlineKernel) it stays enabled for the
  # fallback kernel and is not asserted.
  case "$(uname -r)" in
    *zabbly*) ;;
    *) pro status --format=json | python3 -c "
import json, sys
services = {s['name']: s['status'] for s in json.load(sys.stdin).get('services', [])}
sys.exit(0 if services.get('livepatch') == 'enabled' else 1)
" ;;
  esac
fi`),
      triggers: serverTriggers(
        server,
        pulumi.output(proToken ?? ""),
        "patching-v3",
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

/**
 * MPTCP off. Go opens every listener as MPTCP by default since 1.24, so k3s,
 * cilium, tailscaled and node_exporter all accept it, and the k3s API is on the
 * public internet. Nothing here uses multipath, and CVE-2026-98432 is remote
 * root through exactly that combination. With the sysctl off, Go's MPTCP
 * socket call fails and it falls back to plain TCP. A listener opened before
 * the sysctl changed stays MPTCP until its process restarts, so on a running
 * box this takes effect at the next reboot or service restart.
 *
 * The hostNetwork transports share the host namespace and so the sysctl;
 * a pod's own namespace starts with MPTCP enabled regardless.
 * `scripts/make-seed-drive` carries the same file for home nodes.
 */
export function createNetworkHardening(
  name: string,
  connection: SshConnection,
  server: hcloud.Server,
) {
  return new command.remote.Command(
    `${name}-network-hardening`,
    {
      connection,
      create: `set -euo pipefail
cat > /etc/sysctl.d/99-no-mptcp.conf << 'EOF'
net.mptcp.enabled = 0
EOF
sysctl --system >/dev/null
test "$(sysctl -n net.mptcp.enabled)" = 0`,
      triggers: serverTriggers(server, "mptcp-off-v2"),
    },
    { dependsOn: [server] },
  );
}

/**
 * Lets container processes signal each other under Ubuntu 26.04's AppArmor.
 *
 * With `apparmor_restrict_unprivileged_unconfined` on, the 7.0.0-42 kernel
 * turns runc's switch into containerd's profile into a stack, labelling
 * container processes `cri-containerd.apparmor.d//&unconfined`. containerd's
 * profile allows signals and ptrace only from the unstacked label, so a
 * container cannot signal itself: Go's SIGURG preemption is refused, gosu's
 * setuid never returns, and postgres cannot wake its own checkpointer.
 * containerd/containerd#14487 matches the stacked peer; once a k3s release
 * carries it, this goes. The label is fixed when a process starts, so a
 * container started before this applied keeps the stack until it restarts.
 *
 * The sysctl is Ubuntu's own patch, absent from the mainline kernel
 * (createMainlineKernel), which does not stack; there it is skipped, and the
 * file stays for the Ubuntu kernel kept as a fallback. The leading `-` makes
 * `sysctl --system` ignore the missing key rather than fail, which matters to
 * every other command here that runs it.
 */
export function createAppArmorStackingWorkaround(
  name: string,
  connection: SshConnection,
  server: hcloud.Server,
) {
  return new command.remote.Command(
    `${name}-apparmor-stacking`,
    {
      connection,
      create: `set -euo pipefail
cat > /etc/sysctl.d/99-apparmor-unconfined.conf << 'EOF'
-kernel.apparmor_restrict_unprivileged_unconfined = 0
EOF
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_unconfined ]; then
  sysctl --system >/dev/null
  test "$(sysctl -n kernel.apparmor_restrict_unprivileged_unconfined)" = 0
fi`,
      triggers: serverTriggers(server, "apparmor-unconfined-v2"),
    },
    { dependsOn: [server] },
  );
}

/**
 * Zabbly's signing key, compared before the key is trusted. It is the root of
 * trust for the kernel every box boots, so the fingerprint is pinned here
 * rather than taken from whatever the server returns. Expires 2030-08-17;
 * when Zabbly extends or rotates it, changing this re-runs the install, which
 * fetches and checks the new key.
 */
const ZABBLY_KEY_FINGERPRINT = "4EFC590696CB15B87C73A3AD82CC8797C838DCFD";

/**
 * The trial machinery `createMainlineKernel` describes, as the shell that
 * installs it. `healthUrl` is what must answer before a trial build is kept.
 */
const trialSetup = (
  healthUrl: string,
) => `cat > /etc/default/grub.d/61-trial.cfg << 'EOF'
GRUB_DEFAULT=saved
GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT panic=10"
EOF

cat > /usr/local/sbin/kernel-trial << 'EOF'
#!/bin/bash
set -uo pipefail
state=/var/lib/kernel-trial/pending
metrics=/var/lib/node-exporter/textfile/kernel_trial.prom
health='${healthUrl}'

entry_for() {
  local submenu entry
  submenu=$(grep -o "gnulinux-advanced-[0-9a-f-]*" /boot/grub/grub.cfg | head -1)
  entry=$(grep -o "gnulinux-$1-advanced-[0-9a-f-]*" /boot/grub/grub.cfg | head -1)
  [ -n "$submenu" ] && [ -n "$entry" ] && echo "$submenu>$entry"
}

record() {
  mkdir -p "$(dirname "$metrics")"
  printf 'jaritanet_kernel_trial_failed{version="%s"} %s\\n' "$1" "$2" > "$metrics.tmp"
  mv "$metrics.tmp" "$metrics"
  logger -t kernel-trial "$1: $3"
}

finish() {
  rm -f "$state"
  grub-editenv - unset next_entry
}

case "$1" in
  start)
    case "$2" in
      *zabbly*) ;;
      *) grub-editenv list | grep -q '^saved_entry=.*zabbly' && exit 0 ;;
    esac
    if entry=$(entry_for "$2"); then
      mkdir -p "$(dirname "$state")"
      echo "$2 0" > "$state"
      grub-reboot "$entry" || logger -t kernel-trial "$2: grub-reboot failed"
    else
      logger -t kernel-trial "$2: no GRUB entry"
    fi
    exit 0
    ;;
  check)
    [ -f "$state" ] || exit 0
    read -r version boots < "$state"
    if [ "$(uname -r)" != "$version" ]; then
      finish
      record "$version" 1 "trial kernel not running after $boots boot(s); on $(uname -r)"
      exit 0
    fi
    boots=$((boots + 1))
    echo "$version $boots" > "$state"
    entry=$(entry_for "$version") || {
      finish
      record "$version" 1 "no GRUB entry; left as it is"
      exit 0
    }
    [ "$boots" -lt 3 ] && grub-reboot "$entry"
    deadline=$(($(date +%s) + 600))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      if curl -sf -m 5 -o /dev/null "$health"; then
        grub-set-default "$entry"
        finish
        record "$version" 0 "healthy; now the default"
        exit 0
      fi
      sleep 10
    done
    finish
    record "$version" 1 "not healthy after ten minutes; rebooting to the previous kernel"
    systemctl reboot
    ;;
  adopt)
    entry=$(entry_for "$(uname -r)") || exit 1
    grub-set-default "$entry"
    ;;
esac
EOF
chmod 0755 /usr/local/sbin/kernel-trial

cat > /etc/kernel/postinst.d/zzz-kernel-trial << 'EOF'
#!/bin/sh
/usr/local/sbin/kernel-trial start "$1" || true
EOF
chmod 0755 /etc/kernel/postinst.d/zzz-kernel-trial

cat > /etc/systemd/system/kernel-trial.service << 'EOF'
[Unit]
Description=Keep a trial kernel only if the node comes up healthy on it
After=k3s.service

[Service]
Type=exec
ExecStart=/usr/local/sbin/kernel-trial check

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kernel-trial.service`;

/** Takes the trial off a box that no longer has one, back to GRUB's default. */
const trialRemoval = `rm -f /etc/default/grub.d/61-trial.cfg /etc/kernel/postinst.d/zzz-kernel-trial
if [ -f /etc/systemd/system/kernel-trial.service ]; then
  systemctl disable kernel-trial.service
  rm -f /etc/systemd/system/kernel-trial.service /usr/local/sbin/kernel-trial
  systemctl daemon-reload
fi`;

/**
 * Boots upstream's current stable kernel, built by Zabbly, instead of
 * Canonical's.
 *
 * Ubuntu ships whichever kernel is newest at its release freeze, LTS or not,
 * and then backports fixes into it by hand for the life of the release. 26.04
 * took 7.0, which upstream stopped maintaining within months, so every fix
 * since has waited on Canonical's own backport and release cycle. Zabbly
 * builds each upstream stable release, usually within hours of it, and waits
 * for a new major's first bugfix release before moving to it.
 *
 * What this trusts is one company's build machines and one signing key: the
 * kernel config is public, but the builds are not reproducible from it. That
 * was judged a better trade for an internet-facing box than Canonical's
 * latency. Debian 13, which follows the 6.12 LTS upstream, is the alternative
 * that trusts a distribution instead (radiosilence/jaritanet#1768).
 *
 * Unattended-upgrades takes the repository as one more origin, so new builds
 * install and reboot exactly as security updates do (createAutomaticPatching).
 * `linux-image-zabbly` is a metapackage depending on the current build, which
 * apt installs as a new dependency. The repository also publishes other
 * packages, `linux-libc-dev` among them, at versions that outrank Ubuntu's; an
 * apt pin refuses everything from it but the kernel images, so the trust
 * extends to the kernel and nothing else.
 *
 * With `trialHealthUrl`, a new build is booted on trial and becomes the
 * default only if that URL answers on it. That is the failure that took the
 * estate down once: 7.3 booted cleanly and Cilium 1.20.0's feature probe was
 * rejected by its verifier, so the box ran and moved no packets. The gateway
 * passes the Cilium agent's own health endpoint, which answers only for the
 * agent running now, unlike pod status the API may still hold from before the
 * reboot. Edges run no Cilium and pass nothing: they boot the newest kernel,
 * as GRUB does by default.
 *
 * A kernel hook `grub-reboot`s the new build for the next boot only, leaving
 * GRUB's saved default on the kernel that last passed. `kernel-trial check`
 * runs on every boot. On the trial kernel it re-arms the one-shot entry, so an
 * unrelated reboot during the check returns to the trial rather than counting
 * as a failure (three boots at most), then waits ten minutes for the URL.
 * Healthy, the build is saved as the default; not, the box reboots and GRUB
 * returns to the previous kernel. A build that panics comes back the same
 * way, because `panic=10` is on the command line and so covers panics before
 * userspace too. One that hangs without panicking does not: a Hetzner VPS has
 * no watchdog to reset it, which leaves the console. Each outcome is written
 * to node-exporter's textfile directory as `jaritanet_kernel_trial_failed`,
 * because a refused build otherwise leaves the box quietly on an older kernel,
 * without the fixes it was meant to bring.
 *
 * Canonical's kernels are trialled only while the saved default is one of
 * theirs, so on a mainline box an update to the fallback never takes over, and
 * on a box whose builds keep failing Canonical's own security updates still
 * reach the default. The running kernel is adopted as the default on every
 * deploy without a trial in flight, since the box it is running on is the one
 * being deployed to.
 *
 * Canonical's kernel stays installed beneath the mainline one. The GRUB menu
 * is shown for five seconds rather than the cloud image's zero, so a kernel
 * can still be chosen by hand from Hetzner's console.
 */
export function createMainlineKernel(
  name: string,
  connection: SshConnection,
  server: hcloud.Server,
  trialHealthUrl?: string,
) {
  return new command.remote.Command(
    `${name}-mainline-kernel`,
    {
      connection,
      create: `${remotePreamble}

command -v gpg >/dev/null || {
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gpg
}
key=$(curl -fsSL https://pkgs.zabbly.com/key.asc)
fingerprint=$(printf '%s\\n' "$key" | gpg --show-keys --with-colons 2>/dev/null \\
  | awk -F: '$1 == "fpr" && !seen++ { print $10 }')
if [ "$fingerprint" != "${ZABBLY_KEY_FINGERPRINT}" ]; then
  echo "Zabbly key fingerprint is $fingerprint, expected ${ZABBLY_KEY_FINGERPRINT}" >&2
  exit 1
fi
install -d -m 0755 /etc/apt/keyrings
printf '%s\\n' "$key" > /etc/apt/keyrings/zabbly.asc

cat > /etc/apt/sources.list.d/zabbly-kernel-stable.sources << EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/kernel/stable
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.asc
EOF

cat > /etc/apt/preferences.d/zabbly-kernel << 'EOF'
Package: linux-image-zabbly /^linux-image-[0-9.]+-zabbly\\+$/
Pin: release o=pkgs.zabbly.com,l=kernel-stable
Pin-Priority: 500

Package: *
Pin: release o=pkgs.zabbly.com,l=kernel-stable
Pin-Priority: -1
EOF

mkdir -p /etc/default/grub.d
cat > /etc/default/grub.d/60-fallback-menu.cfg << 'EOF'
GRUB_TIMEOUT_STYLE=menu
GRUB_TIMEOUT=5
EOF
${trialHealthUrl ? trialSetup(trialHealthUrl) : trialRemoval}

cat > /etc/apt/apt.conf.d/52unattended-upgrades-zabbly << 'EOF'
Unattended-Upgrade::Origins-Pattern { "origin=pkgs.zabbly.com,label=kernel-stable"; };
EOF
case "$(apt-config dump)" in
  *'Origins-Pattern:: "origin=pkgs.zabbly.com,label=kernel-stable"'*) ;;
  *) echo "the Zabbly origin did not resolve" >&2; exit 1 ;;
esac

# apt-daily runs every two hours and holds the lists lock while it does, which
# DPkg::Lock::Timeout does not cover.
for attempt in $(seq 30); do
  apt-get update -qq && break
  [ "$attempt" = 30 ] && exit 1
  sleep 20
done
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq linux-image-zabbly
ls /boot/vmlinuz-*-zabbly+ >/dev/null
update-grub
${
  trialHealthUrl
    ? `# The running kernel is the one being deployed to, so it is known good.
[ -f /var/lib/kernel-trial/pending ] || /usr/local/sbin/kernel-trial adopt
grub-editenv list | grep -q '^saved_entry='`
    : "true"
}`,
      triggers: serverTriggers(
        server,
        ZABBLY_KEY_FINGERPRINT,
        "mainline-kernel-v4",
      ),
    },
    { dependsOn: [server] },
  );
}

/**
 * Caps the systemd journal at 1G.
 *
 * journald's default is a tenth of the filesystem up to 4G, and the gateway
 * holds it at the 4G: on a 75G disk shared with container images and dither's
 * cache, that is space the logs, which mostly repeat k3s's, have no use for.
 * The restart is what makes journald read the drop-in; the vacuum trims what is
 * already there instead of waiting for journald to rotate down to the cap.
 * `scripts/make-seed-drive` carries the same file for home nodes.
 */
export function createJournalLimit(
  name: string,
  connection: SshConnection,
  server: hcloud.Server,
) {
  return new command.remote.Command(
    `${name}-journal-limit`,
    {
      connection,
      create: `set -euo pipefail
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/50-size.conf << 'EOF'
[Journal]
SystemMaxUse=1G
EOF
systemctl restart systemd-journald
journalctl --vacuum-size=1G >/dev/null`,
      triggers: serverTriggers(server, "journal-1g-v1"),
    },
    { dependsOn: [server] },
  );
}
