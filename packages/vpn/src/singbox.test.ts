import { describe, expect, it } from "vitest";
import { buildProfile } from "./singbox.ts";

const node = {
  name: "primary",
  server: "1.2.3.4",
  hysteria: {
    altPorts: [3478],
    obfsPassword: "obfs",
    passwords: { jc: "jc-hy2" },
    port: 443,
    sni: "sni.example",
  },
  reality: {
    publicKey: "pk",
    serverNames: ["www.google.co.uk", "www.bing.com"],
    shortId: "sid",
    uuids: { guest1: "uuid-guest1", jc: "uuid-jc" },
  },
};
const exits = [
  {
    name: "home",
    port: 9000,
    method: "aes-128-gcm",
    password: "ss-psk",
    server: "100.74.66.121",
  },
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
    expect(t).toContain("hy2-primary-443");
    expect(t).toContain("reality-primary-google");
    expect(t).toContain("exit-select");
    expect(t).toContain("exit-home");
    expect(p.route.final).toBe("exit-select");

    const realityOut = (p.outbounds as { tag: string; uuid?: string }[]).find(
      (o) => o.tag === "reality-primary-google",
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
    expect(t).toContain("reality-primary-google");
    expect(t).not.toContain("hy2-primary-443");
    expect(t).not.toContain("exit-select");
    expect(t).not.toContain("exit-home");
    expect(p.route.final).toBe("entry-select");

    const realityOut = (p.outbounds as { tag: string; uuid?: string }[]).find(
      (o) => o.tag === "reality-primary-google",
    );
    expect(realityOut?.uuid).toBe("uuid-guest1");

    // No outbound anywhere carries the ss PSK for a guest.
    const json = JSON.stringify(p);
    expect(json).not.toContain("ss-psk");
  });
});

describe("buildProfile exit axis", () => {
  const admin = { name: "jc", role: "admin" } as const;
  const edge = { ...node, name: "edge1", server: "5.6.7.8" };
  const exitOut = (nodes: (typeof node)[]) =>
    (
      buildProfile(admin, nodes, "ts.net", exits).outbounds as {
        tag: string;
        server?: string;
        detour?: string;
      }[]
    ).find((o) => o.tag === "exit-home");

  it("dials the exit node's own address, not a loopback on the entry", () => {
    expect(exitOut([node])?.server).toBe("100.74.66.121");
  });

  // The two axes are independent: the exit is reached over the tailnet, which
  // every entry is a member of, so an exit must not pin to nodes[0].
  it("detours through entry-select whatever the entry count", () => {
    expect(exitOut([node])?.detour).toBe("entry-select");
    expect(exitOut([node, edge])?.detour).toBe("entry-select");
  });
});

describe("buildProfile hy2 ports", () => {
  const admin = { name: "jc", role: "admin" } as const;

  it("gives every listening port its own outbound, main port untagged", () => {
    const p = buildProfile(admin, [node], "ts.net");
    const t = tags(p);
    expect(t).toContain("hy2-primary-443");
    expect(t).toContain("hy2-primary-3478");

    const outs = p.outbounds as { tag: string; server_port?: number }[];
    expect(outs.find((o) => o.tag === "hy2-primary-443")?.server_port).toBe(
      443,
    );
    expect(outs.find((o) => o.tag === "hy2-primary-3478")?.server_port).toBe(
      3478,
    );
  });

  it("puts alt ports in the urltest, so a blocked port fails over unattended", () => {
    const p = buildProfile(admin, [node], "ts.net");
    const auto = (p.outbounds as { tag: string; outbounds?: string[] }[]).find(
      (o) => o.tag === "auto",
    );
    expect(auto?.outbounds).toEqual([
      "hy2-primary-443",
      "hy2-primary-3478",
      "reality-primary-google",
      "reality-primary-bing",
    ]);
  });

  it("emits only the main port when a node has no alt ports", () => {
    const bare = { ...node, hysteria: { ...node.hysteria, altPorts: [] } };
    const t = tags(buildProfile(admin, [bare], "ts.net"));
    expect(t).toContain("hy2-primary-443");
    expect(t).not.toContain("hy2-primary-3478");
  });

  it("keeps hy2 off a guest profile whatever ports the node serves", () => {
    const json = JSON.stringify(
      buildProfile({ name: "guest1", role: "guest" }, [node], "ts.net"),
    );
    expect(json).not.toContain("3478");
  });
});

describe("buildProfile REALITY identities", () => {
  const admin = { name: "jc", role: "admin" } as const;
  const guest = { name: "guest1", role: "guest" } as const;
  const oneSni = {
    ...node,
    reality: { ...node.reality, serverNames: ["www.google.co.uk"] },
  };

  it("gives each SNI its own outbound on the same credentials", () => {
    const outs = buildProfile(admin, [node], "ts.net").outbounds as {
      tag: string;
      uuid?: string;
      tls?: { server_name?: string };
    }[];
    const first = outs.find((o) => o.tag === "reality-primary-google");
    const second = outs.find((o) => o.tag === "reality-primary-bing");

    expect(first?.tls?.server_name).toBe("www.google.co.uk");
    expect(second?.tls?.server_name).toBe("www.bing.com");
    // Same inbound, so the credentials must not diverge with the identity.
    expect(second?.uuid).toBe("uuid-jc");
    expect(first?.uuid).toBe(second?.uuid);
  });

  it("gives a guest a urltest, so an intercepted SNI fails over unattended", () => {
    const p = buildProfile(guest, [node], "ts.net");
    const auto = (p.outbounds as { tag: string; outbounds?: string[] }[]).find(
      (o) => o.tag === "auto",
    );
    // Reality-only, but no longer a single point of failure.
    expect(auto?.outbounds).toEqual([
      "reality-primary-google",
      "reality-primary-bing",
    ]);
    expect(tags(p)).not.toContain("hy2-primary-443");
  });

  it("skips the urltest when a guest node serves one identity", () => {
    const p = buildProfile(guest, [oneSni], "ts.net");
    expect(tags(p)).not.toContain("auto");
    const entry = (p.outbounds as { tag: string; default?: string }[]).find(
      (o) => o.tag === "entry-select",
    );
    expect(entry?.default).toBe("reality-primary-google");
  });
});
