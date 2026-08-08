import { describe, expect, it } from "vitest";
import { relyingParties } from "./services.ts";

/**
 * The redirect allowlist is what stands between the identity provider and an
 * open redirect: without exact matching, a crafted `redirect_uri` walks off
 * with the authorization code and the login provider becomes the attack. So
 * what this function returns is a security control, not a convenience — hence
 * testing it rather than the config that no longer declares any of it.
 */
describe("relyingParties", () => {
  const image = { repository: "x", tag: "1" };
  const services = {
    mariastew: {
      kind: "mariastew",
      hostname: "dl.example",
      image,
      roots: [{ name: "tv", hostPath: "/tv" }],
    },
    "mcp-gateway": { kind: "mcp-gateway", hostname: "mcp.example", image },
    metrics: { kind: "metrics", hostname: "dash.example" },
    navidrome: { kind: "web", hostname: "music.example", args: {} },
    samba: { kind: "samba", shares: [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it("derives one exact redirect URI per relying party", () => {
    expect(relyingParties(services)).toEqual([
      {
        id: "mariastew",
        name: "mariastew",
        redirectUri: "https://dl.example/auth/callback",
      },
      {
        id: "mcp-gateway",
        name: "mcp-gateway",
        redirectUri: "https://mcp.example/auth/callback",
      },
      {
        id: "metrics",
        name: "metrics",
        redirectUri: "https://dash.example/login/generic_oauth",
      },
    ]);
  });

  /**
   * Grafana's callback path is Grafana's, not ours. What stays derived is the
   * host half — that is the part an open redirect would abuse, and no service
   * gets to name it.
   */
  it("takes the callback path from the kind and the host from the service", () => {
    const moved = relyingParties({
      ...services,
      metrics: { ...services.metrics, hostname: "elsewhere.example" },
    });
    expect(moved.find((p) => p.id === "metrics")?.redirectUri).toBe(
      "https://elsewhere.example/login/generic_oauth",
    );
  });

  /** A wildcard on a hostname is how one forgotten subdomain becomes a token thief. */
  it("never emits a pattern a second host could satisfy", () => {
    for (const party of relyingParties(services)) {
      expect(party.redirectUri).not.toContain("*");
      expect(party.redirectUri.startsWith("https://")).toBe(true);
    }
  });

  /** A service that does not sign anyone in has no business holding a client. */
  it("ignores kinds that are not relying parties", () => {
    const ids = relyingParties(services).map((p) => p.id);
    expect(ids).not.toContain("navidrome");
    expect(ids).not.toContain("samba");
  });

  /**
   * An unpublished service has nowhere to be sent back to, so registering one
   * would put an entry in the allowlist that no deployment answers.
   */
  it("skips a service with no hostname", () => {
    expect(
      relyingParties({ mariastew: { ...services.mariastew, hostname: "" } }),
    ).toEqual([]);
  });
});
