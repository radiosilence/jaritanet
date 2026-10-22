import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BtrfsMaintenanceConfSchema } from "./btrfs.schemas.ts";
import { DAMAGE_AWK, scrubScript, snapshotScript } from "./btrfs.ts";

/**
 * The scrub's damage list is only as good as this parse of the kernel's own
 * wording, so it runs under a real awk against lines in the kernel's format
 * rather than being asserted as a string.
 */
const damage = (log: string[]) =>
  execFileSync("awk", [DAMAGE_AWK], { input: log.join("\n") + "\n" })
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .toSorted();

const ref = (logical: number, root: number, path: string) =>
  `BTRFS warning (device sda1): checksum error at logical ${logical} on dev /dev/sda1, physical 1048576, root ${root}, inode 4242, offset 0, length 4096, links 1 (path: ${path})`;

describe("DAMAGE_AWK", () => {
  it("reports every file reference in a block that was not repaired", () => {
    expect(
      damage([
        ref(1000, 256, "Burial/Untrue/03 Near Dark.flac"),
        ref(1000, 257, "Burial/Untrue/03 Near Dark.flac"),
        "BTRFS error (device sda1): scrub: unable to fixup (regular) error at logical 1000 on dev /dev/sda1 physical 1048576",
      ]),
    ).toEqual([
      "256 Burial/Untrue/03 Near Dark.flac",
      "257 Burial/Untrue/03 Near Dark.flac",
    ]);
  });

  it("drops blocks repaired from a mirror", () => {
    expect(
      damage([
        ref(2000, 256, "Polar Bear/Held on the Tips of Fingers/01.flac"),
        "BTRFS info (device sda1): scrub: fixed up error at logical 2000 on dev /dev/sdb physical 2097152",
      ]),
    ).toEqual([]);
  });

  it("reports nothing for a clean scrub", () => {
    expect(
      damage([
        "BTRFS info (device sda1): scrub: started on devid 1",
        "BTRFS info (device sda1): scrub: finished on devid 1 with status: 0",
      ]),
    ).toEqual([]);
  });
});

describe("scrubScript", () => {
  const conf = BtrfsMaintenanceConfSchema.parse({
    mount: "/mnt/kontent",
    snapshot: {
      subvolume: "/mnt/kontent/music",
      dir: "/mnt/kontent/.snapshots/music",
    },
  });

  it("is valid sh, with and without metrics", () => {
    // Three layers of quoting (TypeScript, sh, awk) meet in this script, and
    // a mistake in any of them is a syntax error on the node at 05:00.
    for (const c of [conf, { ...conf, metricsDir: "/var/lib/textfile" }]) {
      expect(() =>
        execFileSync("sh", ["-n"], { input: scrubScript(c) }),
      ).not.toThrow();
    }
  });

  it("escapes folder names into valid label values", () => {
    // The sed program the script uses, run against a name with both of the
    // characters that would otherwise end the label value early.
    const sed = /sed '\/\^\$\/d; ([^']+)'/.exec(
      scrubScript({ ...conf, metricsDir: "/var/lib/textfile" }),
    )?.[1];
    expect(sed).toBeDefined();
    const escaped = execFileSync("sed", [sed!], {
      input: 'music/"Weird Al"/back\\slash\n',
    }).toString();
    expect(escaped).toBe('music/\\"Weird Al\\"/back\\\\slash\n');
  });

  it("refuses a snapshot directory outside the mount", () => {
    expect(() =>
      scrubScript({
        ...conf,
        snapshot: { ...conf.snapshot, dir: "/srv/snaps" },
      }),
    ).toThrow("/srv/snaps is not under /mnt/kontent");
  });
});

describe("snapshotScript", () => {
  it("is valid sh, with and without metrics", () => {
    const conf = BtrfsMaintenanceConfSchema.parse({
      mount: "/mnt/kontent",
      snapshot: {
        subvolume: "/mnt/kontent/music",
        dir: "/mnt/kontent/.snapshots/music",
      },
    });
    for (const c of [conf, { ...conf, metricsDir: "/var/lib/textfile" }]) {
      expect(() =>
        execFileSync("sh", ["-n"], { input: snapshotScript(c) }),
      ).not.toThrow();
    }
  });
});
