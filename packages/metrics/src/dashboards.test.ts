import { describe, expect, it } from "vitest";
import {
  DATASOURCE_UID,
  dashboardFiles,
  HOME_DASHBOARD,
} from "./dashboards.ts";

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

/**
 * The landing page is meant to answer "is anything wrong" without anybody
 * reading a query, so what is checked here is the two ways a tile lies: a
 * colour that runs the wrong way, and a number nothing can be traced back to.
 */
describe("the overview's triage row", () => {
  const overview = JSON.parse(dashboardFiles()[`${HOME_DASHBOARD}.json`]);
  const stats = overview.panels.filter(
    (p: { type: string }) => p.type === "stat",
  );

  it("is what Grafana opens on", () => {
    expect(dashboardFiles()).toHaveProperty(`${HOME_DASHBOARD}.json`);
    expect(stats.length).toBeGreaterThan(0);
  });

  /**
   * A tile reading 94% is useless if it cannot say 94% of what. `max()` would
   * drop the labels; `topk(1, …)` is what keeps them.
   */
  it("names what every number belongs to", () => {
    for (const stat of stats) {
      expect(stat.targets[0].legendFormat, stat.title).not.toBe("");
      expect(stat.options.textMode, stat.title).toBe("value_and_name");
    }
  });

  /**
   * Thresholds ascend because Grafana requires it, so a lower-is-worse tile —
   * time left on a certificate — expresses itself by reversing the colours
   * instead. Getting that backwards paints a healthy certificate red and an
   * expiring one green, which is worse than having no tile.
   */
  it("colours a lower-is-worse tile the other way round", () => {
    for (const stat of stats) {
      const steps = stat.fieldConfig.defaults.thresholds.steps;
      const values = steps.slice(1).map((s: { value: number }) => s.value);
      expect(values, stat.title).toEqual([...values].toSorted((a, b) => a - b));
      expect([steps[0].color, steps.at(-1).color], stat.title).toEqual(
        stat.title === "Certificate renews in"
          ? ["red", "green"]
          : ["green", "red"],
      );
    }
  });

  /**
   * cAdvisor reports each container and the pod-level cgroup holding them under
   * the same `pod` label, so anything summed by pod counts every pod twice.
   * That reads as a service using double what it does, which on a page whose
   * job is to be believed at a glance is the worst kind of wrong.
   */
  it("never sums a pod's containers together with their own cgroup", () => {
    const summed = overview.panels
      .flatMap((p: { targets: { expr: string }[] }) => p.targets)
      .filter((t: { expr: string }) => t.expr.includes("sum by"))
      .filter((t: { expr: string }) => t.expr.includes("container_"));
    expect(summed.length).toBeGreaterThan(0);
    for (const target of summed) {
      expect(target.expr).toContain('container!=""');
    }
  });
});
