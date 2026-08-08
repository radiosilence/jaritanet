import { describe, expect, it } from "vitest";
import { DATASOURCE_UID, dashboardFiles } from "./dashboards.ts";

/**
 * A dashboard fails the way a schema cannot catch: it renders, and the panel is
 * empty. So what is checked here is the two ways that happens silently — a
 * panel pointed at a datasource that was never provisioned, and a disk panel
 * keyed on a label that follows the enumeration order rather than the disk.
 */
describe("dashboardFiles", () => {
  const files = dashboardFiles();
  const dashboards = Object.values(files).map((json) => JSON.parse(json));
  const panels = dashboards.flatMap((d) => d.panels);

  it("names the provisioned datasource on every panel", () => {
    for (const panel of panels) {
      expect(panel.datasource.uid, panel.title).toBe(DATASOURCE_UID);
    }
  });

  it("gives every panel at least one query", () => {
    for (const panel of panels) {
      expect(panel.targets.length, panel.title).toBeGreaterThan(0);
      for (const target of panel.targets) {
        expect(target.expr, panel.title).not.toBe("");
      }
    }
  });

  /**
   * `sdb` is whichever external was enumerated second this boot. A panel keyed
   * on it graphs a different disk after a replug and raises nothing — so where
   * a mountpoint exists it is used, and where one does not the panel says so.
   */
  it("admits it when a panel is keyed on a kernel device name", () => {
    const disks = dashboards.find((d) => d.uid === "jaritanet-disks");
    for (const panel of disks.panels) {
      const byDevice = panel.targets.some((t: { legendFormat: string }) =>
        t.legendFormat.includes("{{device}}"),
      );
      if (byDevice)
        expect(panel.description, panel.title).toMatch(/enumeration/);
    }
  });

  /** The filesystem panels are the ones that must survive a replug. */
  it("keys filesystem panels on the mountpoint", () => {
    const disks = dashboards.find((d) => d.uid === "jaritanet-disks");
    const filesystem = disks.panels.filter(
      (p: { targets: { expr: string }[] }) =>
        p.targets.some((t) => t.expr.includes("node_filesystem")),
    );
    expect(filesystem.length).toBeGreaterThan(0);
    for (const panel of filesystem) {
      for (const target of panel.targets) {
        expect(target.legendFormat, panel.title).toContain("{{mountpoint}}");
      }
    }
  });

  it("gives each dashboard its own file and uid", () => {
    const uids = dashboards.map((d) => d.uid);
    expect(new Set(uids).size).toBe(uids.length);
    expect(Object.keys(files).toSorted()).toEqual(
      uids.map((uid) => `${uid}.json`).toSorted(),
    );
  });
});
