import { describe, expect, it } from "vitest";
import { listenPort, redirectScript } from "./hysteria.ts";

describe("listenPort", () => {
  // The node redirects 443 to this, so it must be unprivileged and must not
  // land on another transport's port.
  it("moves a privileged port above 1024", () => {
    expect(listenPort(443)).toBe(10443);
  });

  it("leaves an unprivileged port where clients dial it", () => {
    expect(listenPort(3478)).toBe(3478);
    expect(listenPort(4500)).toBe(4500);
  });
});

describe("redirectScript", () => {
  const script = redirectScript([{ port: 443, to: 10443 }]);

  it("redirects the port in a table of its own, at dstnat", () => {
    expect(script).toContain("table inet jaritanet_hysteria {");
    expect(script).toContain("type nat hook prerouting priority dstnat");
    expect(script).toContain("udp dport 443 redirect to :10443");
  });

  // Without this the rule would outlive the pod and black-hole the port.
  it("removes the table when the pod is stopped", () => {
    expect(script).toContain("trap cleanup TERM INT");
    expect(script).toContain("nft delete table inet jaritanet_hysteria");
  });

  it("flushes conntrack for the port, so tracked flows pick the rule up", () => {
    expect(script).toContain("conntrack -D -p udp --orig-port-dst 443");
  });
});
