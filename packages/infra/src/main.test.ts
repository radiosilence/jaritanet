import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import { createTunnel } from "./modules/tunnel.ts";

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

describe("infrastructure main", () => {
  it("creates tunnel with config", async () => {
    const tunnel = createTunnel({ name: "test-tunnel" });

    expect(tunnel).toBeDefined();

    const urn = await new Promise<string>((resolve) => {
      tunnel.urn.apply((value) => resolve(value));
    });

    expect(urn).toContain("ZeroTrustTunnelCloudflared");
  });
});
