import { describe, expect, it } from "vitest";
import { buildProfile } from "./singbox.ts";

const node = {
  name: "primary",
  server: "1.2.3.4",
  hysteria: {
    obfsPassword: "obfs",
    passwords: { jc: "jc-hy2" },
    port: 443,
    sni: "sni.example",
  },
  reality: {
    publicKey: "pk",
    serverName: "sni.example",
    shortId: "sid",
    uuids: { guest1: "uuid-guest1", jc: "uuid-jc" },
  },
};
const exits = [
  { name: "home", port: 9000, method: "aes-128-gcm", password: "ss-psk" },
];

const tags = (p: ReturnType<typeof buildProfile>) =>
  (p.outbounds as { tag: string }[]).map((o) => o.tag);

describe("buildProfile roles", () => {
  it("gives an admin hy2 + reality with their own UUID, plus the exit axis", () => {
    const p = buildProfile(
      { name: "jc", role: "admin" },
      [node],
      "ts.net",
      exits,
    );
    const t = tags(p);
    expect(t).toContain("hy2-primary");
    expect(t).toContain("reality-primary");
    expect(t).toContain("exit-select");
    expect(t).toContain("exit-home");
    expect(p.route.final).toBe("exit-select");

    const realityOut = (p.outbounds as { tag: string; uuid?: string }[]).find(
      (o) => o.tag === "reality-primary",
    );
    expect(realityOut?.uuid).toBe("uuid-jc");

    // The ss PSK reaches an admin profile.
    const exitOut = (p.outbounds as { tag: string; password?: string }[]).find(
      (o) => o.tag === "exit-home",
    );
    expect(exitOut?.password).toBe("ss-psk");
  });

  it("gives a guest reality-only, direct egress, and no exit/hy2/PSK", () => {
    const p = buildProfile(
      { name: "guest1", role: "guest" },
      [node],
      "ts.net",
      exits,
    );
    const t = tags(p);
    expect(t).toContain("reality-primary");
    expect(t).not.toContain("hy2-primary");
    expect(t).not.toContain("hy2b-primary");
    expect(t).not.toContain("exit-select");
    expect(t).not.toContain("exit-home");
    expect(p.route.final).toBe("entry-select");

    const realityOut = (p.outbounds as { tag: string; uuid?: string }[]).find(
      (o) => o.tag === "reality-primary",
    );
    expect(realityOut?.uuid).toBe("uuid-guest1");

    // No outbound anywhere carries the ss PSK for a guest.
    const json = JSON.stringify(p);
    expect(json).not.toContain("ss-psk");
  });
});
