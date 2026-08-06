import { describe, expect, it } from "vitest";
import {
  AbsolutePath,
  Hostname,
  HostPort,
  LabelKey,
  Port,
  Quantity,
} from "./schemas.ts";

/**
 * These shapes are checked in one place and relied on in several, and each one
 * exists because the corresponding mistake fails somewhere far from the value.
 * Both directions matter: a validator that accepts everything is decorative,
 * and one that rejects a legitimate value fails the deploy for no reason.
 */
describe.each([
  {
    name: "Hostname",
    schema: Hostname,
    valid: ["music.blit.cc", "p.radiosilence.dev", "www.bing.com"],
    invalid: ["Music.Blit.CC", "sympathy", "-lead.example.com", ""],
  },
  {
    name: "HostPort",
    schema: HostPort,
    valid: ["127.0.0.1:8443", "www.microsoft.com:443"],
    invalid: ["www.microsoft.com", ":443", "host:"],
  },
  {
    name: "Port",
    schema: Port,
    valid: [1, 443, 65535],
    invalid: [0, 65536, 1.5, -1],
  },
  {
    name: "AbsolutePath",
    schema: AbsolutePath,
    valid: ["/mnt/kontent", "/srv/files"],
    invalid: ["mnt/kontent", "./relative", ""],
  },
  {
    name: "LabelKey",
    schema: LabelKey,
    valid: ["jaritanet.radiosilence.dev/vpn-entry"],
    invalid: ["novalue", "UPPER.example.com/x", "example.com/"],
  },
  {
    name: "Quantity",
    schema: Quantity,
    valid: ["500m", "2", "64Mi", "8Gi"],
    invalid: ["8 Gi", "lots", "-1"],
  },
])("$name", ({ schema, valid, invalid }) => {
  it.each(valid as unknown[])("accepts %o", (value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it.each(invalid as unknown[])("rejects %o", (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
