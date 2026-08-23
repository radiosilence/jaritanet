import { describe, expect, it } from "vitest";
import { authRoutes, firstPartyClients } from "./auth.ts";

describe("firstPartyClients", () => {
  const client = {
    id: "mariastew",
    name: "mariastew",
    redirectUri: "https://dl.example/auth/callback",
    secret: "generated",
  };

  it("writes the shape the provider parses", () => {
    expect(JSON.parse(firstPartyClients([client]))).toEqual([
      {
        id: "mariastew",
        name: "mariastew",
        secret: "generated",
        redirect_uris: ["https://dl.example/auth/callback"],
      },
    ]);
  });

  /**
   * The allowlist is what stands between this and an open redirect, so an entry
   * carries exactly the URI derived for it — never a pattern that a second host
   * could satisfy.
   */
  it("registers one exact redirect URI per client, with no wildcard", () => {
    const [entry] = JSON.parse(firstPartyClients([client]));
    expect(entry.redirect_uris).toHaveLength(1);
    expect(entry.redirect_uris[0]).not.toContain("*");
  });

  it("is an empty list rather than absent when nothing needs auth", () => {
    expect(firstPartyClients([])).toBe("[]");
  });
});

describe("authRoutes", () => {
  /**
   * Everything not claimed here stays with Hydra on the same hostname —
   * `/oauth2/*`, `/.well-known/*` and `/userinfo` in particular, since those are
   * what a relying party discovers and what would break silently.
   */
  it("claims no path Hydra serves", () => {
    const rule = authRoutes().join(" || ");
    for (const hydra of ["/oauth2", "/.well-known", "/userinfo"]) {
      expect(rule).not.toContain(hydra);
    }
  });

  it("claims the login, consent and registration endpoints", () => {
    const rule = authRoutes().join(" || ");
    expect(rule).toContain("/auth/");
    expect(rule).toContain("/register");
  });
});
