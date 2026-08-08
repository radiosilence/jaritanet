import { describe, expect, it } from "vitest";
import {
  MariastewConfSchema,
  MariastewRootSchema,
} from "./mariastew.schemas.ts";

const image = { repository: "ghcr.io/radiosilence/mariastew", tag: "0.1.0" };
const roots = [{ name: "tv", hostPath: "/mnt/kontent/tv" }];

describe("MariastewRootSchema", () => {
  it("rejects a relative host path, which would mount the wrong thing silently", () => {
    expect(() =>
      MariastewRootSchema.parse({ name: "tv", hostPath: "mnt/tv" }),
    ).toThrow();
  });

  it("rejects an unknown key rather than stripping it", () => {
    expect(() =>
      MariastewRootSchema.parse({
        name: "tv",
        hostPath: "/mnt/tv",
        mountPath: "/tv",
      }),
    ).toThrow();
  });
});

describe("MariastewConfSchema", () => {
  it("refuses a service with no roots: there would be nowhere to download to", () => {
    expect(() => MariastewConfSchema.parse({ image, roots: [] })).toThrow();
  });

  it("defaults hostname to empty, which means built but not published", () => {
    expect(MariastewConfSchema.parse({ image, roots }).hostname).toBe("");
  });

  it("seeds indefinitely by default — ratio zero means no limit", () => {
    expect(MariastewConfSchema.parse({ image, roots }).aria2.seedRatio).toBe(
      "0.0",
    );
  });

  it("defaults the aria2 tuning that the deployment relies on", () => {
    const { aria2 } = MariastewConfSchema.parse({ image, roots });
    expect(aria2).toEqual({
      limits: { cpu: "4", memory: "2Gi" },
      listenPort: 51413,
      upnp: true,
      peerSpeedLimit: "50M",
      btMaxPeers: 0,
      maxConcurrentDownloads: 16,
      maxConnectionPerServer: 16,
      maxOverallDownloadLimit: "0",
      maxOverallUploadLimit: "0",
      seedRatio: "0.0",
    });
  });

  it("defaults the OAuth client id, so only the issuer has to be configured", () => {
    const conf = MariastewConfSchema.parse({
      image,
      roots,
      oidc: { issuer: "https://auth.example.com" },
    });
    expect(conf.oidc?.clientId).toBe("mariastew");
  });

  it("treats oidc as optional, which is how an unpublished deployment parses", () => {
    expect(MariastewConfSchema.parse({ image, roots }).oidc).toBeUndefined();
  });
});
