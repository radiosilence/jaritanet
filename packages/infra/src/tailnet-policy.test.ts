import { describe, expect, it } from "vitest";
import { buildTailnetPolicy } from "./tailnet-policy.ts";

const args = {
  clusterPeers: ["100.74.66.121"],
  owners: ["jc@blit.cc"],
  tags: ["tag:server", "tag:ci"],
};

describe("buildTailnetPolicy", () => {
  it("defines every tag the fleet advertises", () => {
    expect(buildTailnetPolicy(args).tagOwners).toEqual({
      "tag:ci": ["jc@blit.cc"],
      "tag:server": ["jc@blit.cc"],
    });
  });

  it("defines a repeated tag once", () => {
    // The gateway and every edge advertise tag:server, so the union arrives
    // with duplicates rather than being deduped at each call site.
    const { tagOwners } = buildTailnetPolicy({
      ...args,
      tags: ["tag:server", "tag:server", "tag:ci"],
    });

    expect(Object.keys(tagOwners)).toEqual(["tag:ci", "tag:server"]);
  });

  it("asserts every peer on what the cluster's dataplane needs", () => {
    // Cilium carries pod traffic over the tailnet (#238), so a grant that drops
    // these partitions the cluster instead of degrading access. The provider
    // validates `tests` before applying, which is what makes that a failed
    // deploy rather than a silent blackhole.
    expect(buildTailnetPolicy(args).tests).toEqual([
      { src: "tag:ci", proto: "udp", accept: ["100.74.66.121:8472"] },
      { src: "tag:ci", proto: "tcp", accept: ["100.74.66.121:10250"] },
      { src: "tag:server", proto: "udp", accept: ["100.74.66.121:8472"] },
      { src: "tag:server", proto: "tcp", accept: ["100.74.66.121:10250"] },
    ]);
  });

  it("asserts VXLAN over udp", () => {
    // Tailscale evaluates a test as TCP unless told otherwise, so omitting
    // `proto` here would assert a port nothing uses and pass against a policy
    // that drops every packet Cilium sends.
    const vxlan = buildTailnetPolicy(args).tests.filter((test) =>
      test.accept.some((dst) => dst.endsWith(":8472")),
    );

    expect(vxlan.length).toBeGreaterThan(0);
    expect(vxlan.every((test) => test.proto === "udp")).toBe(true);
  });

  it("asserts nothing when no peer needs reaching", () => {
    expect(buildTailnetPolicy({ ...args, clusterPeers: [] }).tests).toEqual([]);
  });

  it("leaves access unrestricted", () => {
    // Narrowing this is #239's separate act. A change here is a behaviour
    // change wearing a refactor's clothes.
    expect(buildTailnetPolicy(args).acls).toEqual([
      { action: "accept", src: ["*"], dst: ["*:*"] },
    ]);
  });

  it("emits parseable JSON", () => {
    // JSON is valid HuJSON, which is why no HuJSON writer is involved.
    expect(() =>
      JSON.parse(JSON.stringify(buildTailnetPolicy(args))),
    ).not.toThrow();
  });
});
