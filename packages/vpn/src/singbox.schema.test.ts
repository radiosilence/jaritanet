import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildProfile } from "./singbox.ts";

/**
 * The profile is hand-built from objects, so nothing but a device rejecting it
 * has ever checked its shape — and a profile that fails to parse fails on every
 * device at once, since they all fetch the same file. Validating against
 * sing-box's own schema moves that discovery from the fleet to CI.
 *
 * Vendored rather than fetched so tests stay offline and a schema change is a
 * reviewable diff. It is the *published* (latest) schema, so it catches typos,
 * bad enums and misplaced keys — not version skew against whatever core the
 * fleet actually runs. For that, generate one from the pinned build
 * (`sing-box schema -o`) and validate against both.
 */
const schema = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../schemas/sing-box.json"),
    "utf8",
  ),
);
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
  schema,
);

const check = (profile: unknown) => {
  const ok = validate(profile);
  return { ok, errors: validate.errors ?? [] };
};

const node = {
  name: "primary",
  server: "1.2.3.4",
  hysteria: {
    altPorts: [3478, 4500],
    obfsPassword: "obfs",
    passwords: { jc: "jc-hy2" },
    port: 443,
    sni: "www.bing.com",
  },
  reality: {
    publicKey: "pk",
    serverNames: ["www.google.co.uk", "www.bing.com", "www.apple.com"],
    shortId: "sid",
    uuids: { guest1: "uuid-guest1", jc: "uuid-jc" },
  },
};
const edge = { ...node, name: "helsinki", server: "5.6.7.8" };
const exits = [
  { name: "oldboy", port: 9000, method: "aes-128-gcm", password: "ss-psk" },
];

describe("delivered profiles are valid sing-box configs", () => {
  it.each([
    ["admin, one node, with exits", { name: "jc", role: "admin" }, [node]],
    ["guest, one node", { name: "guest1", role: "guest" }, [node]],
    ["admin, several nodes", { name: "jc", role: "admin" }, [node, edge]],
    ["guest, several nodes", { name: "guest1", role: "guest" }, [node, edge]],
  ] as const)("%s", (_label, user, nodes) => {
    const { ok, errors } = check(
      buildProfile(user, [...nodes], "ts.net", exits),
    );
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  // Without this, a validator wired up wrongly — a schema that failed to
  // compile, a $ref that resolved to `true` — would pass everything above and
  // report nothing, which is worse than having no test at all.
  it("rejects a profile the real thing would reject", () => {
    const profile = buildProfile(
      { name: "jc", role: "admin" },
      [node],
      "ts.net",
    );
    const { ok } = check({
      ...profile,
      outbounds: [{ type: "not-a-real-protocol", tag: "nope" }],
    });
    expect(ok).toBe(false);
  });
});
