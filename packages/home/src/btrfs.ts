import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import { BtrfsMaintenanceConfSchema } from "./btrfs.schemas.ts";

/**
 * Fails unless `mount` is a mounted btrfs filesystem. `stat -f` triggers the
 * systemd automount, so an absent drive is reported here rather than mistaken
 * for the empty directory underneath it.
 */
const requireBtrfs = (mount: string) =>
  `[ "$(stat -f -c %T ${mount})" = btrfs ] || { echo "${mount} is not a mounted btrfs filesystem" >&2; exit 1; }`;

/**
 * Reads btrfs kernel messages and prints `<root> <path>` for every file
 * reference in a block the scrub could not repair.
 *
 * The kernel logs each bad block twice: once per file reference, with the
 * subvolume id and the path inside that subvolume, and once more saying
 * whether it was fixed. Only the second says which outcome, and only the first
 * names a file, so the two are joined on the block's logical address. Blocks
 * that were repaired from a mirror are dropped.
 */
export const DAMAGE_AWK = `
/unable to fixup/ {
  if (match($0, /logical [0-9]+/)) bad[substr($0, RSTART + 8, RLENGTH - 8)] = 1
  next
}
/\\(path: / {
  if (!match($0, /logical [0-9]+/)) next
  logical = substr($0, RSTART + 8, RLENGTH - 8)
  if (!match($0, /root [0-9]+/)) next
  root = substr($0, RSTART + 5, RLENGTH - 5)
  path = $0
  sub(/.*\\(path: /, "", path)
  sub(/\\)$/, "", path)
  refs[logical] = refs[logical] root " " path "\\n"
}
END { for (logical in bad) printf "%s", refs[logical] }
`;

/**
 * Escapes a line for use as a Prometheus label value. Folder names come from
 * the library, and a quote or backslash left raw makes node-exporter reject
 * the whole file.
 */
const PROM_ESCAPE = String.raw`s/\\/\\\\/g; s/"/\\"/g`;

/**
 * Shell that writes `body`'s output to `<dir>/<name>.prom`, or nothing when no
 * directory is configured. Written beside and then renamed, because
 * node-exporter reads the directory whenever it is scraped and a half-written
 * file is a parse error; the temporary name does not end in `.prom`, so it is
 * never read.
 */
const promFile = (dir: string | undefined, name: string, body: string) =>
  dir
    ? `mkdir -p ${dir}
{
${body}
} > ${dir}/${name}.prom.$$ && mv -f ${dir}/${name}.prom.$$ ${dir}/${name}.prom
`
    : "";

/** `path` relative to `mount`, which must contain it. */
const under = (mount: string, path: string) => {
  if (!path.startsWith(`${mount}/`)) {
    throw new Error(`${path} is not under ${mount}`);
  }
  return path.slice(mount.length + 1);
};

/**
 * Reads every block on every device and rewrites any copy whose checksum fails
 * from its mirror. btrfs repairs bad blocks only when something reads them, so
 * without this a mirror that fell behind during a USB dropout, or a block that
 * rotted on disk, is found only when the other copy is also needed.
 *
 * Afterwards it lists the folders holding a file the scrub could not repair,
 * since those are what has to be fetched again. A path under a snapshot is
 * reported as its place in the live subvolume, because the snapshot shares the
 * same blocks and the fix is the same. The kernel rate-limits these messages,
 * so a badly damaged disk produces an incomplete list; the error counts in
 * `btrfs scrub status` are not limited.
 *
 * The result goes to Telegram whether or not anything was found, so a month
 * with no message means the scrub did not run. The token is written to curl's
 * config on stdin rather than its arguments, which any process on the node
 * could read.
 */
export const scrubScript = (
  btrfs: z.infer<typeof BtrfsMaintenanceConfSchema>,
) => {
  const snapshots = under(btrfs.mount, btrfs.snapshot.dir);
  const subvolume = under(btrfs.mount, btrfs.snapshot.subvolume);
  return `set -u
${requireBtrfs(btrfs.mount)}
notify() {
  [ -n "\${TELEGRAM_BOT_TOKEN:-}" ] || return 0
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\\n' "$TELEGRAM_BOT_TOKEN" |
    curl -sS -o /dev/null -K - --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \\
      --data-urlencode "text=$(printf '%s' "$1" | head -c 4000)" ||
    echo "telegram notification failed" >&2
}
since=$(date +%s)
ionice -c3 nice -n19 btrfs scrub start -B -d ${btrfs.mount}
status=$?
damaged=$(journalctl -k -o cat --since "@$since" | awk '${DAMAGE_AWK}' |
  while read -r root path; do
    sub=$(btrfs inspect-internal subvolid-resolve "$root" ${btrfs.mount})
    dirname "\${sub:+$sub/}$path"
  done | sed 's#^${snapshots}/[^/]*#${subvolume}#' | sort -u)
host=$(hostname)
if [ -n "$damaged" ]; then
  status=1
  text=$(printf 'btrfs scrub of ${btrfs.mount} on %s found damage it could not repair. Affected folders:\\n%s' "$host" "$damaged")
elif [ "$status" -ne 0 ]; then
  text="btrfs scrub of ${btrfs.mount} on $host failed (exit $status). See the job log."
else
  text="btrfs scrub of ${btrfs.mount} on $host finished: $(btrfs scrub status ${btrfs.mount} | sed -n 's/^Error summary: *//p')"
fi
printf '%s\\n' "$text"
notify "$text"
raw=$(btrfs scrub status -R ${btrfs.mount})
field() { printf '%s\\n' "$raw" | sed -n "s/^[[:space:]]*$1: *//p"; }
${promFile(
  btrfs.metricsDir,
  "btrfs_scrub",
  `printf '# TYPE btrfs_scrub_last_run_timestamp_seconds gauge\\nbtrfs_scrub_last_run_timestamp_seconds{mount="%s"} %s\\n' ${btrfs.mount} "$(date +%s)"
printf '# TYPE btrfs_scrub_success gauge\\nbtrfs_scrub_success{mount="%s"} %s\\n' ${btrfs.mount} "$([ "$status" -eq 0 ] && echo 1 || echo 0)"
echo '# TYPE btrfs_scrub_errors gauge'
for kind in corrected uncorrectable; do
  value=$(field "\${kind}_errors")
  [ -z "$value" ] || printf 'btrfs_scrub_errors{mount="%s",kind="%s"} %s\\n' ${btrfs.mount} "$kind" "$value"
done
echo '# TYPE btrfs_scrub_damaged_folder gauge'
printf '%s\\n' "$damaged" | sed '/^$/d; ${PROM_ESCAPE}' |
  while IFS= read -r folder; do
    printf 'btrfs_scrub_damaged_folder{mount="%s",folder="%s"} 1\\n' ${btrfs.mount} "$folder"
  done`,
)}exit "$status"
`;
};

/**
 * Takes a read-only snapshot, then deletes all but the newest `keep`. Names
 * are UTC timestamps, so lexical order is age order. Deletion goes through
 * `btrfs subvolume delete`, which refuses anything that is not a subvolume, so
 * a stray file in the directory is left alone rather than removed.
 */
export const snapshotScript = (
  btrfs: z.infer<typeof BtrfsMaintenanceConfSchema>,
) => {
  const { subvolume, dir, keep } = btrfs.snapshot;
  return `set -eu
${requireBtrfs(btrfs.mount)}
mkdir -p ${dir}
btrfs subvolume snapshot -r ${subvolume} ${dir}/$(date -u +%Y-%m-%dT%H%M%SZ)
ls -1 ${dir} | sort | head -n -${keep} | while read -r name; do
  btrfs subvolume delete ${dir}/"$name"
done
${promFile(
  btrfs.metricsDir,
  "btrfs_snapshot",
  `printf '# TYPE btrfs_snapshot_last_timestamp_seconds gauge\\nbtrfs_snapshot_last_timestamp_seconds{subvolume="%s"} %s\\n' ${subvolume} "$(date +%s)"
printf '# TYPE btrfs_snapshots gauge\\nbtrfs_snapshots{subvolume="%s"} %s\\n' ${subvolume} "$(ls -1 ${dir} | wc -l)"`,
)}`;
};

/**
 * Scrub and snapshot CronJobs for the media filesystem, pinned to the node
 * that holds it.
 *
 * Both run the host's own `btrfs` through `nsenter` into PID 1's namespaces
 * rather than shipping btrfs-progs in an image. The seed installs it on the
 * node already, so the tool always matches the kernel it is driving, and the
 * container is only a way in. That needs `hostPID` and `privileged`, which is
 * no wider than the job itself: scrubbing and snapshotting are root-only ioctls
 * on the filesystem.
 *
 * `concurrencyPolicy: Forbid` because a scrub of a few terabytes over USB runs
 * for hours, and a second one started alongside would only halve the speed of
 * both. The scrub starts at 05:00 so that it begins after the node's 04:00
 * unattended-upgrade reboot window rather than being cut off by it.
 *
 * `telegram` is optional; without it the scrub reports only to its own log.
 */
export function createBtrfsMaintenance(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  btrfsArgs: z.input<typeof BtrfsMaintenanceConfSchema>,
  nodeLabel: string,
  telegram?: { botToken: pulumi.Input<string>; chatId: string },
) {
  const btrfs = BtrfsMaintenanceConfSchema.parse(btrfsArgs);

  const telegramSecret =
    telegram &&
    new k8s.core.v1.Secret(
      "btrfs-scrub-telegram",
      {
        metadata: { name: "btrfs-scrub-telegram", namespace },
        stringData: {
          TELEGRAM_BOT_TOKEN: telegram.botToken,
          TELEGRAM_CHAT_ID: telegram.chatId,
        },
      },
      { provider },
    );

  const cronJob = (
    name: string,
    schedule: string,
    script: string,
    secret?: k8s.core.v1.Secret,
  ) =>
    new k8s.batch.v1.CronJob(
      name,
      {
        metadata: { name, namespace },
        spec: {
          schedule,
          timeZone: btrfs.timeZone,
          concurrencyPolicy: "Forbid",
          jobTemplate: {
            spec: {
              backoffLimit: 1,
              template: {
                spec: {
                  restartPolicy: "Never",
                  hostPID: true,
                  automountServiceAccountToken: false,
                  nodeSelector: { [nodeLabel]: "true" },
                  containers: [
                    {
                      name,
                      image: btrfs.image,
                      command: [
                        "nsenter",
                        "-t",
                        "1",
                        "-m",
                        "-u",
                        "-i",
                        "-n",
                        "-p",
                        "--",
                        "sh",
                        "-c",
                        script,
                      ],
                      resources: {
                        requests: { cpu: "10m", memory: "16Mi" },
                        limits: { memory: "128Mi" },
                      },
                      envFrom: secret
                        ? [{ secretRef: { name: secret.metadata.name } }]
                        : undefined,
                      securityContext: { privileged: true },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      { provider },
    );

  cronJob(
    "btrfs-scrub",
    btrfs.scrubSchedule,
    scrubScript(btrfs),
    telegramSecret,
  );
  cronJob("btrfs-snapshot", btrfs.snapshot.schedule, snapshotScript(btrfs));
}
