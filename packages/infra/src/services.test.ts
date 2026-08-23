import type { Deployed } from "@jaritanet/k8s";
import { describe, expect, it } from "vitest";
import { registration, zoneFor } from "./services.ts";

/**
 * The redirect allowlist is what stands between the identity provider and an
 * open redirect: without exact matching, a crafted `redirect_uri` walks off
 * with the authorization code and the login provider becomes the attack.
 *
 * Most of that property is now structural rather than tested — a service builds
 * its redirect URI from the same binding it publishes at, so the two cannot
 * disagree. What is left to guard is the seam between the service declaring a
 * client and the stack minting its secret, which is the one place the two
 * halves can silently fail to meet.
 */
describe("registration", () => {
  const withClient: Deployed = {
    routes: [{ service: "mariastew", hostname: "dl.example" }],
    oidc: {
      id: "mariastew",
      name: "mariastew",
      redirectUri: "https://dl.example/auth/callback",
    },
  };

  it("pairs a declared client with its secret", () => {
    expect(registration(withClient, "s3cret")).toEqual({
      id: "mariastew",
      name: "mariastew",
      redirectUri: "https://dl.example/auth/callback",
      secret: "s3cret",
    });
  });

  it("has nothing to register for a service that signs nobody in", () => {
    expect(registration({ routes: [] })).toBeUndefined();
  });

  /**
   * The failure this prevents is silent: the service deploys, publishes, and
   * cannot log anybody in, with nothing anywhere reporting a fault.
   */
  it("refuses a client with no secret rather than dropping it", () => {
    expect(() => registration(withClient)).toThrow(/no secret/);
  });
});

describe("zoneFor", () => {
  const zones = [
    { name: "blit.cc", zoneId: "1", modules: [] },
    { name: "radiosilence.dev", zoneId: "2", modules: [] },
  ];

  it("matches a subdomain to its zone", () => {
    expect(zoneFor(zones, "dl.blit.cc")?.zoneId).toBe("1");
  });

  it("matches the apex", () => {
    expect(zoneFor(zones, "blit.cc")?.zoneId).toBe("1");
  });

  it("reports nothing for a hostname in no configured zone", () => {
    expect(zoneFor(zones, "example.com")).toBeUndefined();
  });

  /**
   * Documented rather than desired. A two-label match cannot see
   * `example.co.uk`, and the record is skipped in silence — the same split
   * `createServiceRecord` makes, so both halves are wrong together.
   */
  it("cannot see a three-label zone", () => {
    expect(
      zoneFor(
        [{ name: "example.co.uk", zoneId: "3", modules: [] }],
        "a.example.co.uk",
      ),
    ).toBeUndefined();
  });
});
