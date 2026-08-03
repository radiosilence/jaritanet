import { describe, expect, it } from "vitest";
import { SambaConfSchema } from "./samba.schemas.ts";
import { smbConf } from "./samba.ts";

/**
 * smb.conf is parsed by smbd at exec, so a malformed stanza is a crash loop
 * rather than a warning — and the shares are the part assembled from config, so
 * they are the part worth pinning. These assert the rendered file, not our
 * schema, for the same reason the mcp registry tests assert the wire format.
 */
const parse = (shares: unknown[]) =>
  smbConf(SambaConfSchema.parse({ guestAccount: "jc", shares }));

const music = { name: "music", hostPath: "/mnt/kontent/music" };

describe("smbConf", () => {
  it("renders a share as its own stanza, read-only by default", () => {
    expect(parse([music])).toContain(
      [
        "[music]",
        "  path = /shares/music",
        "  browseable = yes",
        "  read only = yes",
        "  guest ok = yes",
        "  guest only = yes",
      ].join("\n"),
    );
  });

  it("mounts by share name, not by host path", () => {
    // The container never sees /mnt/kontent — the hostPath is a volume detail,
    // and putting it in `path` would export a directory that does not exist
    // inside the container.
    const conf = parse([music]);
    expect(conf).toContain("path = /shares/music");
    expect(conf).not.toContain("/mnt/kontent");
  });

  it("carries a writable share through as read only = no", () => {
    expect(
      parse([{ name: "dl", hostPath: "/mnt/kontent/dl", readOnly: false }]),
    ).toContain("read only = no");
  });

  it("keeps stanzas separate when there are several", () => {
    const conf = parse([music, { name: "tv", hostPath: "/mnt/kontent/tv" }]);
    expect(conf).toContain("\n[music]\n");
    expect(conf).toContain("\n[tv]\n");
    // Two shares, two paths — a join that dropped its separator would still
    // contain both names while emitting one unparseable stanza.
    expect(conf.match(/^\[/gm)).toHaveLength(3); // global + 2 shares
  });

  it("restricts access to the tailnet and the LAN, never the internet", () => {
    // A hostNetwork pod bypasses the CNI, so no NetworkPolicy backs this up.
    expect(parse([music])).toContain(
      "hosts allow = 100.64.0.0/10 192.168.0.0/16 127.0.0.1",
    );
  });

  it("maps unknown users onto the account that owns the media", () => {
    const conf = parse([music]);
    expect(conf).toContain("map to guest = Bad User");
    expect(conf).toContain("guest account = jc");
  });

  it("serves SMB2+ on 445 only, with no NetBIOS", () => {
    const conf = parse([music]);
    expect(conf).toContain("server min protocol = SMB2");
    expect(conf).toContain("disable netbios = yes");
    expect(conf).toContain("smb ports = 445");
  });
});
