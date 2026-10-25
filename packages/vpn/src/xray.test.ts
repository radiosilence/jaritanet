import { describe, expect, it } from "vitest";
import { buildProfile } from "./singbox.ts";
import { FREEDOM_FINAL_RULES } from "./xray.ts";

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
    const tailnetRoute = (
      profile.route.rules as { ip_cidr?: string[]; outbound?: string }[]
    ).find((r) => r.ip_cidr);
    const tailnetRule = FREEDOM_FINAL_RULES.find((r) => !r.port);
    expect(tailnetRule?.ip).toEqual(tailnetRoute?.ip_cidr);
  });
});
