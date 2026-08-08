import { describe, expect, it } from "vitest";

import { resourceRequests } from "./util.ts";

describe("resourceRequests", () => {
  /**
   * The regression this exists for. Kubernetes defaults a missing request to
   * its limit, so declaring a memory ceiling reserved it: navidrome held 4Gi
   * and mariastew 1Gi of lady's 7.9Gi while both used single-digit megabytes,
   * and nothing else could be scheduled.
   */
  it("derives a memory request rather than leaving it to default to the limit", () => {
    expect(resourceRequests({ cpu: "4", memory: "2Gi" })).toEqual({
      requests: { cpu: "200m", memory: "102Mi" },
    });
  });

  it("reads both millicores and whole cores", () => {
    expect(resourceRequests({ cpu: "500m" }).requests?.cpu).toBe("25m");
    expect(resourceRequests({ cpu: "2" }).requests?.cpu).toBe("100m");
  });

  it("understands the decimal and binary suffixes alike", () => {
    expect(resourceRequests({ memory: "20Gi" }).requests?.memory).toBe(
      "1024Mi",
    );
    expect(resourceRequests({ memory: "20G" }).requests?.memory).toBe("954Mi");
  });

  /**
   * A floor rather than a proportion at the small end: a twentieth of a
   * modest ceiling rounds to something the scheduler cannot meaningfully
   * reserve, and a container still needs somewhere to start.
   */
  it("floors a small ceiling instead of requesting almost nothing", () => {
    expect(resourceRequests({ cpu: "50m", memory: "256Mi" })).toEqual({
      requests: { cpu: "10m", memory: "32Mi" },
    });
  });

  it("omits what it was not given, and yields nothing from nothing", () => {
    expect(resourceRequests({ cpu: "1" })).toEqual({
      requests: { cpu: "50m" },
    });
    expect(resourceRequests(undefined)).toEqual({});
    expect(resourceRequests({})).toEqual({});
  });

  /**
   * Silence rather than a guess: a quantity this cannot parse falls back to
   * Kubernetes' own defaulting, which is conservative. Inventing a number
   * from a string we did not understand is the worse failure.
   */
  it("skips a quantity it cannot parse", () => {
    expect(resourceRequests({ memory: "lots" })).toEqual({});
    expect(resourceRequests({ cpu: "fast", memory: "1Gi" })).toEqual({
      requests: { memory: "51Mi" },
    });
  });
});
