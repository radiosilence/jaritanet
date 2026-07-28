import { describe, expect, it } from "vitest";
import { McpSchema } from "./mcp-gateway.schemas.ts";

/**
 * A backend declares how the gateway gets its credentials: one header, several
 * fields, or nothing at all. Exactly one — the rule exists so a backend that
 * declares none is a deploy-time error rather than an MCP quietly fronted
 * without a key.
 */
describe("McpSchema credentials", () => {
  const base = {
    id: "x",
    name: "X",
    image: "ghcr.io/example/x:v1",
  };

  it("accepts the single-header shorthand", () => {
    const b = McpSchema.parse({ ...base, credentialHeader: "X-Token" });
    expect(b.public).toBeUndefined();
  });

  it("accepts a multi-field backend", () => {
    const b = McpSchema.parse({
      ...base,
      fields: [{ id: "user", label: "User", header: "X-User" }],
    });
    expect(b.fields).toHaveLength(1);
  });

  it("accepts a public backend with no credentials", () => {
    const b = McpSchema.parse({ ...base, public: true });
    expect(b.public).toBe(true);
    expect(b.credentialHeader).toBeUndefined();
    expect(b.fields).toBeUndefined();
  });

  it("rejects a backend declaring nothing", () => {
    // The typo case: silence must not be read as "needs no credentials".
    expect(() => McpSchema.parse(base)).toThrow();
  });

  it("rejects public alongside a credential", () => {
    // One of the two is a mistake, and guessing which would either drop a
    // credential or put a connect form on a backend that has nothing to store.
    expect(() =>
      McpSchema.parse({
        ...base,
        public: true,
        credentialHeader: "X-Token",
      }),
    ).toThrow();
    expect(() =>
      McpSchema.parse({
        ...base,
        public: true,
        fields: [{ id: "user", label: "User", header: "X-User" }],
      }),
    ).toThrow();
  });

  it("rejects both credential forms together", () => {
    expect(() =>
      McpSchema.parse({
        ...base,
        credentialHeader: "X-Token",
        fields: [{ id: "user", label: "User", header: "X-User" }],
      }),
    ).toThrow();
  });

  it("treats public: false as no declaration at all", () => {
    // Otherwise `public: false` would satisfy the rule while declaring nothing.
    expect(() => McpSchema.parse({ ...base, public: false })).toThrow();
  });
});
