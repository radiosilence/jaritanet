import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Mock the conf.ts module directly
vi.mock("./conf.ts", () => ({
  conf: {
    cloudflare: { accountId: "test-account-id" },
    tunnel: { name: "test-tunnel" },
  },
}));

beforeAll(() => {
  // Set runtime mocks
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

describe("infrastructure main", () => {
  it("creates tunnel with config", async () => {
    const { createTunnel } = await import("./modules/tunnel.ts");
    const tunnel = createTunnel({ name: "test-tunnel" });

    expect(tunnel).toBeDefined();

    const urn = await new Promise<string>((resolve) => {
      tunnel.urn.apply((value) => resolve(value));
    });

    expect(urn).toContain("ZeroTrustTunnelCloudflared");
  });
});
