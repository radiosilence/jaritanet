import { describe, expect, it } from "vitest";
import { listenPort } from "./hysteria.ts";

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
