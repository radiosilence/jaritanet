import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { tunnel } from "./main.ts";

describe("infrastructure main", () => {
  beforeAll(() => {
    // Set up mocks for resource creation
    pulumi.runtime.setMocks({
      newResource: (args: pulumi.runtime.MockResourceArgs) => ({
        id: `${args.inputs.name || "test"}_id`,
        state: {
          ...args.inputs,
          id: `${args.inputs.name || "test"}_id`,
        },
      }),
      call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
    });
  });

  it("exports tunnel resource", async () => {
    expect(tunnel).toBeDefined();

    const urn = await new Promise<string>((resolve) => {
      tunnel.urn.apply((value) => resolve(value));
    });

    expect(urn).toContain("ZeroTrustTunnelCloudflared");
  });
});
