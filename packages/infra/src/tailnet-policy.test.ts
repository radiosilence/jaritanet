import { describe, expect, it } from "vitest";
import { buildTailnetPolicy } from "./tailnet-policy.ts";

const args = {
  clusterPeers: ["100.74.66.121"],
  owners: ["jc@blit.cc"],
  tags: ["tag:server", "tag:ci"],
  podNetwork: { cidr: "10.42.0.0/16", routers: ["tag:server"] },
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
    // Pod traffic crosses the tailnet, so a grant that drops these partitions
    // the cluster instead of degrading access. The provider validates `tests`
    // before applying, which is what makes that a failed deploy rather than a
    // silent blackhole.
    expect(buildTailnetPolicy(args).tests).toEqual([
      { src: "tag:ci", proto: "tcp", accept: ["100.74.66.121:10250"] },
      { src: "tag:ci", proto: "tcp", accept: ["10.42.0.1:443"] },
      { src: "tag:server", proto: "tcp", accept: ["100.74.66.121:10250"] },
      { src: "tag:server", proto: "tcp", accept: ["10.42.0.1:443"] },
    ]);
  });

  it("approves the pod network's routes for the cluster's tag alone", () => {
    // Cluster nodes accept routes so they can reach each other's pods; this
    // is what bounds what they can be handed.
    expect(buildTailnetPolicy(args).autoApprovers).toEqual({
      routes: { "10.42.0.0/16": ["tag:server"] },
    });
  });

  it("approves nothing without a pod network", () => {
    const { podNetwork: _, ...noPods } = args;

    expect(buildTailnetPolicy(noPods)).not.toHaveProperty("autoApprovers");
    expect(
      buildTailnetPolicy(noPods).tests.flatMap((test) => test.accept),
    ).toEqual(["100.74.66.121:10250", "100.74.66.121:10250"]);
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
