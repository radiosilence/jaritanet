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
 * Reads every block on every device and rewrites any copy whose checksum fails
 * from its mirror. btrfs repairs bad blocks only when something reads them, so
 * without this a mirror that fell behind during a USB dropout, or a block that
 * rotted on disk, is found only when the other copy is also needed. Exits
 * non-zero on uncorrectable errors, which fails the Job.
 */
const scrubScript = (btrfs: z.infer<typeof BtrfsMaintenanceConfSchema>) =>
  `set -eu
${requireBtrfs(btrfs.mount)}
exec ionice -c3 nice -n19 btrfs scrub start -B -d ${btrfs.mount}
`;

/**
 * Takes a read-only snapshot, then deletes all but the newest `keep`. Names
 * are UTC timestamps, so lexical order is age order. Deletion goes through
 * `btrfs subvolume delete`, which refuses anything that is not a subvolume, so
 * a stray file in the directory is left alone rather than removed.
 */
const snapshotScript = (btrfs: z.infer<typeof BtrfsMaintenanceConfSchema>) => {
  const { subvolume, dir, keep } = btrfs.snapshot;
  return `set -eu
${requireBtrfs(btrfs.mount)}
mkdir -p ${dir}
btrfs subvolume snapshot -r ${subvolume} ${dir}/$(date -u +%Y-%m-%dT%H%M%SZ)
ls -1 ${dir} | sort | head -n -${keep} | while read -r name; do
  btrfs subvolume delete ${dir}/"$name"
done
`;
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
 */
export function createBtrfsMaintenance(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  btrfsArgs: z.input<typeof BtrfsMaintenanceConfSchema>,
  nodeLabel: string,
) {
  const btrfs = BtrfsMaintenanceConfSchema.parse(btrfsArgs);

  const cronJob = (name: string, schedule: string, script: string) =>
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

  cronJob("btrfs-scrub", btrfs.scrubSchedule, scrubScript(btrfs));
  cronJob("btrfs-snapshot", btrfs.snapshot.schedule, snapshotScript(btrfs));
}
