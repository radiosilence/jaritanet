import { describe, expect, it } from "vitest";
import { CILIUM_K8S_SUPPORT, checkCiliumSupport } from "./compat.ts";
import { K3sConfSchema } from "./k3s.schemas.ts";

describe("checkCiliumSupport", () => {
  it.each([
    ["1.20.0", "v1.36.3+k3s1"],
    ["1.20.0", "v1.33.0+k3s1"],
    ["1.19.6", "v1.34.1+k3s1"],
    ["1.18.12", "v1.30.0+k3s1"],
  ])("pairs cilium %s with k3s %s", (cilium, k3s) => {
    expect(checkCiliumSupport(cilium, k3s)).toBeUndefined();
  });

  it.each([
    ["1.19.6", "v1.36.3+k3s1", "above the tested ceiling"],
    ["1.20.0", "v1.32.0+k3s1", "below the tested floor"],
  ])("rejects cilium %s with k3s %s — %s", (cilium, k3s) => {
    expect(checkCiliumSupport(cilium, k3s)).toMatch(
      /tested against Kubernetes/,
    );
  });

  it("rejects a cilium minor with no row rather than assuming it is fine", () => {
    expect(checkCiliumSupport("1.99.0", "v1.36.3+k3s1")).toMatch(
      /not in the support table/,
    );
  });

  it.each([
    ["nope", "v1.36.3+k3s1"],
    ["1.20.0", "latest"],
  ])("rejects unparseable versions (%s, %s)", (cilium, k3s) => {
    expect(checkCiliumSupport(cilium, k3s)).toMatch(/no major\.minor/);
  });

  it("has a floor no higher than its ceiling in every row", () => {
    for (const [cilium, [min, max]] of Object.entries(CILIUM_K8S_SUPPORT)) {
      expect(`${cilium}: ${min} <= ${max}`).toBe(
        `${cilium}: ${min <= max ? min : max} <= ${max}`,
      );
    }
  });
});

describe("K3sConfSchema", () => {
  it("accepts its own defaults", () => {
    expect(() => K3sConfSchema.parse({})).not.toThrow();
  });

  it("fails to parse a half-bump, so a preview goes red before any resource", () => {
    expect(() =>
      K3sConfSchema.parse({
        ciliumVersion: "1.18.12",
        version: "v1.36.3+k3s1",
      }),
    ).toThrow(/tested against Kubernetes/);
  });
});
