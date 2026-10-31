import { describe, expect, it } from "vitest";
import { buildProfile } from "./singbox.ts";
import { FREEDOM_FINAL_RULES } from "./xray.ts";
import { XrayConfSchema } from "./xray.schemas.ts";

describe("XrayConfSchema", () => {
  const serverNames = ["koan.rocks", "www.microsoft.com", "www.bing.com"];

  it("leaves the CDN-fronted XHTTP inbound off unless asked for", () => {
    expect(XrayConfSchema.parse({ serverNames }).xhttp).toBeUndefined();
  });

  it("defaults the XHTTP inbound's port and checks its hostname", () => {
    expect(
      XrayConfSchema.parse({
        serverNames,
        xhttp: { hostname: "cdn.koan.rocks" },
      }).xhttp,
    ).toEqual({ hostname: "cdn.koan.rocks", port: 10443 });
    expect(() =>
      XrayConfSchema.parse({ serverNames, xhttp: { hostname: "Not A Host" } }),
    ).toThrow();
  });

  // An own name beside a borrowed one is still one outbound per first label.
  it("rejects server names whose first labels collide", () => {
    expect(() =>
      XrayConfSchema.parse({ serverNames: ["koan.rocks", "www.koan.com"] }),
    ).toThrow(/distinct first labels/);
  });
});

const node = {
  name: "primary",
  server: "1.2.3.4",
  hysteria: {
    altPorts: [],
    certificate: "pem",
    obfsPassword: "obfs",
    passwords: { jc: "jc-hy2" },
    port: 443,
    sni: "sni.example",
  },
  reality: {
    publicKey: "pk",
    serverNames: ["www.bing.com"],
    shortId: "sid",
    uuids: { jc: "uuid-jc" },
  },
};

describe("FREEDOM_FINAL_RULES", () => {
  it("opens the gateway's loopback for DNS only", () => {
    const loopback = FREEDOM_FINAL_RULES.filter((r) =>
      r.ip.some((c) => c.startsWith("127.")),
    );
    expect(loopback).toEqual([
      { action: "allow", network: "tcp,udp", port: "53", ip: ["127.0.0.1/32"] },
    ]);
  });

  it("opens exactly the tailnet ranges the profile routes through the entry", () => {
    const profile = buildProfile(
      { name: "jc", role: "admin" },
      [node],
      "ts.net",
    );
    const routed = (
      profile.route.rules as { ip_cidr?: string[]; outbound?: string }[]
    ).flatMap((r) => (r.outbound === "entry-select" && r.ip_cidr) || []);
    const tailnetRule = FREEDOM_FINAL_RULES.find((r) => !r.port);
    expect(tailnetRule?.ip?.toSorted()).toEqual(routed.toSorted());
  });
});
