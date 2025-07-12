import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

describe("fastmail module", () => {
  beforeAll(() => {
    // Set up mocks first
    pulumi.runtime.setMocks({
      newResource: (
        args: pulumi.runtime.MockResourceArgs,
      ): {
        id: string;
        state: any;
      } => ({
        id: `${args.inputs.name || args.name || "test"}_id`,
        state: {
          ...args.inputs,
          id: `${args.inputs.name || args.name || "test"}_id`,
        },
      }),
      call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
    });

    // Set up required config for fastmail
    pulumi.runtime.setConfig(
      "jaritanet-routes:fastmail",
      JSON.stringify({
        mxDomain: "messagingengine.com",
        dkimDomain: "messagingengine.com",
        dkimSubdomain: "fm1._domainkey",
        dmarcSubdomain: "_dmarc",
        dmarcAggEmail: "admin@example.com",
        dmarcPolicy: "reject",
        spfDomain: "messagingengine.com",
      }),
    );

    pulumi.runtime.setConfig(
      "jaritanet-routes:zones",
      JSON.stringify({
        "example.com": { zoneId: "test-zone-id", name: "example.com" },
      }),
    );

    pulumi.runtime.setConfig(
      "jaritanet-routes:serviceStacks",
      JSON.stringify({
        "k8s": "test-stack"
      }),
    );
  });

  it("creates fastmail DNS records", async () => {
    // Import after mocks are set up
    const { fastmail } = await import("./fastmail.ts");

    const zone = {
      zoneId: "test-zone-id",
      name: "example.com",
      modules: ["fastmail"] as ("bluesky" | "fastmail")[],
    };

    // This will create the MX, DKIM, SPF, and DMARC records
    fastmail(zone);

    // Test passes if no errors are thrown during execution
    expect(true).toBe(true);
  });
});
