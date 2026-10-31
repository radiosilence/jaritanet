import { type Device, planClaim } from "./claim-tailnet-name.ts";

const args = { self: "nNEW", hostname: "sympathy", tag: "tag:server" };
const device = (over: Partial<Device>): Device => ({
  nodeId: "nNEW",
  hostname: "sympathy",
  name: "sympathy.example.ts.net",
  tags: ["tag:server"],
  ...over,
});

describe("planClaim", () => {
  it("does nothing for a node that already holds its name", () => {
    expect(planClaim([device({})], args)).toEqual({
      remove: [],
      rename: false,
    });
  });

  it("deletes the replaced node and takes its name", () => {
    const devices = [
      device({ nodeId: "nOLD" }),
      device({ name: "sympathy-1.example.ts.net" }),
    ];
    expect(planClaim(devices, args)).toEqual({
      remove: ["nOLD"],
      rename: true,
    });
  });

  it("deletes every predecessor, whatever name each ended up with", () => {
    const devices = [
      device({ nodeId: "nOLD" }),
      device({ nodeId: "nOLDER", name: "sympathy-1.example.ts.net" }),
      device({ name: "sympathy-2.example.ts.net" }),
    ];
    expect(planClaim(devices, args).remove).toEqual(["nOLD", "nOLDER"]);
  });

  it("leaves devices it did not register alone", () => {
    const devices = [
      device({ nodeId: "nLAPTOP", tags: undefined }),
      device({ nodeId: "nEDGE", tags: ["tag:edge"] }),
      device({
        nodeId: "nLADY",
        hostname: "lady",
        name: "lady.example.ts.net",
      }),
      device({}),
    ];
    expect(planClaim(devices, args).remove).toEqual([]);
  });

  it("refuses when the node is not registered", () => {
    expect(() => planClaim([device({ nodeId: "nOLD" })], args)).toThrow(
      /nNEW is not in/,
    );
  });
});
