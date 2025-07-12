import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Mock the conf.ts module directly
vi.mock("../conf.ts", () => ({
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

describe("tunnel module", () => {
  it("creates a tunnel with correct name", async () => {
    const { createTunnel } = await import("./tunnel.ts");
    const tunnel = createTunnel({ name: "test-tunnel" });

    const name = await new Promise<string>((resolve) => {
      tunnel.name.apply((value) => resolve(value));
    });

    expect(name).toBe("test-tunnel");
  });

  it("creates a tunnel with secret", async () => {
    const { createTunnel } = await import("./tunnel.ts");
    const tunnel = createTunnel({ name: "test-tunnel" });

    const tunnelSecret = await new Promise<string>((resolve) => {
      tunnel.tunnelSecret.apply((value) => resolve(value ?? ""));
    });

    expect(tunnelSecret).toBeDefined();
    expect(typeof tunnelSecret).toBe("string");
  });

  it("tunnel has proper resource type", async () => {
    const { createTunnel } = await import("./tunnel.ts");
    const tunnel = createTunnel({ name: "test-tunnel" });

    const urn = await new Promise<string>((resolve) => {
      tunnel.urn.apply((value) => resolve(value));
    });

    expect(urn).toContain(
      "cloudflare:index/zeroTrustTunnelCloudflared:ZeroTrustTunnelCloudflared",
    );
  });
});
