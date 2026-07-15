import { describe, expect, it } from "vitest";
import { parseVpnUsers } from "./env.schema.ts";

describe("parseVpnUsers", () => {
  it("parses names and marks a trailing + as admin", () => {
    expect(parseVpnUsers("jc+,guest1")).toEqual([
      { name: "jc", role: "admin" },
      { name: "guest1", role: "guest" },
    ]);
  });

  it("trims whitespace around tokens and the + marker", () => {
    expect(parseVpnUsers("  jc + , guest1 ")).toEqual([
      { name: "jc", role: "admin" },
      { name: "guest1", role: "guest" },
    ]);
  });

  it("skips empty tokens (stray/trailing commas)", () => {
    expect(parseVpnUsers("jc+,,guest1,")).toEqual([
      { name: "jc", role: "admin" },
      { name: "guest1", role: "guest" },
    ]);
  });

  it("returns an empty list for an empty string", () => {
    expect(parseVpnUsers("")).toEqual([]);
  });

  it("throws on a duplicate name", () => {
    expect(() => parseVpnUsers("jc+,jc")).toThrow(/duplicate/);
  });

  it("throws on an invalid name charset", () => {
    expect(() => parseVpnUsers("bad name")).toThrow(/invalid/);
    expect(() => parseVpnUsers("no.dots")).toThrow(/invalid/);
    expect(() => parseVpnUsers("1leading")).toThrow(/invalid/);
  });
});
