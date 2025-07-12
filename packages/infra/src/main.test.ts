import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

pulumi.runtime.setMocks({
  newResource: (
    args: pulumi.runtime.MockResourceArgs,
  ): {
    id: string;
    state: any;
  } => ({
    id: `${args.inputs.name || "test"}_id`,
    state: {
      ...args.inputs,
      id: `${args.inputs.name || "test"}_id`,
    },
  }),
  call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
});

describe("infrastructure main", () => {
  beforeAll(() => {
    // Set up required config
    pulumi.runtime.setConfig(
      "jaritanet-infra:cloudflare",
      JSON.stringify({
        accountId: "test-account-id",
      }),
    );
    pulumi.runtime.setConfig(
      "jaritanet-infra:tunnel",
      JSON.stringify({
        name: "test-tunnel",
      }),
    );
  });

  it("exports tunnel resource", async () => {
    const { tunnel } = await import("./main.ts");

    expect(tunnel).toBeDefined();

    const urn = await new Promise<string>((resolve) => {
      tunnel.urn.apply((value) => resolve(value));
    });

    expect(urn).toContain("ZeroTrustTunnelCloudflared");
  });
});
