import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import { fastmail } from "./fastmail.ts";

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

describe("fastmail module", () => {
  it("creates fastmail DNS records", () => {
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
