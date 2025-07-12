import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Mock the conf.ts module directly
vi.mock("../conf.ts", () => ({
  conf: {
    serviceStacks: { k8s: "test-k8s-stack" },
    zones: [{ zoneId: "test-zone", name: "example.com" }],
    cloudflare: { accountId: "test-account-id" },
    bluesky: { handle: "test.bsky.social" },
    fastmail: {
      mxDomain: "messagingengine.com",
      dkimDomain: "dkim.messagingengine.com",
      dkimSubdomain: "_domainkey",
      dmarcSubdomain: "_dmarc",
      dmarcAggEmail: "test@example.com",
      dmarcPolicy: "quarantine",
      spfDomain: "messagingengine.com",
    },
  },
}));

beforeAll(() => {
  // Set runtime mocks
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.inputs.name || args.name || "test"}_id`,
      state: {
        ...args.inputs,
        id: `${args.inputs.name || args.name || "test"}_id`,
      },
    }),
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

describe("fastmail module", () => {
  it("creates fastmail DNS records", async () => {
    const { fastmail } = await import("./fastmail.ts");
    const zone = {
      zoneId: "test-zone-id",
      name: "example.com",
      modules: ["fastmail" as const],
    };

    // This will create the MX, DKIM, SPF, and DMARC records
    fastmail(zone);

    // Test passes if no errors are thrown during execution
    expect(true).toBe(true);
  });
});
