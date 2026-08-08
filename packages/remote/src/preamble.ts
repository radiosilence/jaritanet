/**
 * What every `command.remote.Command` in this repo opens with.
 *
 * Pulumi SSHes in the moment the server answers, which is long before the box
 * is usable, so two things have to be waited on. cloud-init, or the directories
 * these scripts write into do not exist yet; and the dpkg lock, because Ubuntu
 * runs unattended-upgrades *after* cloud-init finishes and holds it for
 * minutes, so every apt call exits 100 until it lets go.
 *
 * Telling apt itself to wait is the only approach that also covers the vendor
 * install scripts (k3s, xray, hysteria, tailscale), which shell out to apt with
 * no flags we can pass. A polling loop here cannot help those, and `fuser` is
 * not installed on the minimal cloud image anyway.
 *
 * Both are idempotent and return immediately once the box has settled, so every
 * command opens with this rather than only whichever one reaches the box first
 * — that ordering is a property of the dependency graph, not something a script
 * can assume. It is a string rather than a function because the shell is the
 * same on every box; nothing about it varies per call site.
 */
export const remotePreamble = `set -euo pipefail
cloud-init status --wait >/dev/null 2>&1 || true
mkdir -p /etc/apt/apt.conf.d
printf 'DPkg::Lock::Timeout "600";\\n' > /etc/apt/apt.conf.d/99-lock-timeout`;
