import * as z from "zod";
import { AbsolutePath } from "@jaritanet/k8s";

/**
 * Scrub and snapshot jobs for one btrfs filesystem on the file node.
 *
 * `snapshot.subvolume` must be a subvolume rather than a directory, because a
 * snapshot covers exactly one subvolume. Snapshots land in `snapshot.dir`,
 * which must sit outside the subvolume so nothing scanning the library walks
 * into its own history.
 */
export const BtrfsMaintenanceConfSchema = z.object({
  mount: AbsolutePath,
  /** Whole-filesystem scrub, as a cron expression in `timeZone`. */
  scrubSchedule: z.string().default("0 5 1 * *"),
  snapshot: z.object({
    subvolume: AbsolutePath,
    dir: AbsolutePath,
    /** How many snapshots to keep; older ones are deleted after each run. */
    keep: z.number().int().positive().default(14),
    schedule: z.string().default("0 3 * * *"),
  }),
  timeZone: z.string().default("Europe/London"),
  /** Only used to run `nsenter`; everything else is the host's own binaries. */
  image: z.string().default("busybox:1.37.0"),
});
