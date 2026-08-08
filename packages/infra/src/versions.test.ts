import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";
import {
  applyTemplate,
  decide,
  normaliseVersion,
  parseImageRef,
  pickLatestTag,
  readAt,
  STRINGIFY_OPTIONS,
  TrackedListSchema,
  verifyRef,
  writeAt,
} from "./versions.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const config = () =>
  readFile(join(ROOT, "packages", "infra", "Pulumi.main.yaml"), "utf8");
const tracked = async () =>
  TrackedListSchema.parse(
    parse(
      await readFile(join(ROOT, ".github", "tracked-versions.yml"), "utf8"),
    ),
  );

describe("normaliseVersion", () => {
  it.each([
    ["v3.2.1", "3.2.1"],
    ["traefik-34.5.0", "34.5.0"],
    ["v0.63.2", "0.63.2"],
    ["2024.1.0", "2024.1.0"],
    ["v10.0.0-rc1", "10.0.0-rc1"],
  ])("%s -> %s", (tag, expected) => {
    expect(normaliseVersion(tag)).toBe(expected);
  });
});

describe("pickLatestTag", () => {
  // Newest first, as the releases API returns them, and both containers
  // releasing from this one repo.
  const tags = [
    "files-v1.0.1",
    "serve-from-env-v0.2.0",
    "files-v1.0.0",
    "serve-from-env-v0.1.0",
  ];

  it("takes the newest release of the component asked for", () => {
    expect(pickLatestTag(tags, "serve-from-env-v")).toBe(
      "serve-from-env-v0.2.0",
    );
    expect(pickLatestTag(tags, "files-v")).toBe("files-v1.0.1");
  });

  it("takes the newest of any component without a prefix", () => {
    expect(pickLatestTag(tags)).toBe("files-v1.0.1");
  });

  it("finds nothing for a component that has never released", () => {
    expect(pickLatestTag(tags, "blit-v")).toBeUndefined();
    expect(pickLatestTag([], "files-v")).toBeUndefined();
  });

  // The prefix is what stops `files-v1.0.1` being read as serve-from-env's
  // version and pinning it to an image that was never built.
  it("does not confuse one component's release for another's", () => {
    expect(
      normaliseVersion(pickLatestTag(tags, "serve-from-env-v") ?? ""),
    ).toBe("0.2.0");
  });

  // The releases API returned mariastew's history with 0.1.9 ahead of 0.1.19,
  // and comparing the tags as whole strings agreed: "9" > "1". Reported as
  // #345 — the workflow called 0.1.9 up to date while 0.1.19 was live.
  it("sorts by version rather than trusting the order it is given", () => {
    const outOfOrder = [
      "mariastew-v0.1.9",
      "mariastew-v0.1.8",
      "mariastew-v0.1.19",
      "mariastew-v0.1.10",
      "mariastew-v0.1.0",
    ];
    expect(pickLatestTag(outOfOrder, "mariastew-v")).toBe("mariastew-v0.1.19");
  });
});

describe("parseImageRef", () => {
  it("treats a two-part name as Docker Hub", () => {
    expect(parseImageRef("deluan/navidrome:0.63.2")).toEqual({
      registry: "docker.io",
      repository: "deluan/navidrome",
      tag: "0.63.2",
    });
  });

  it("treats a three-part name as a host plus repository", () => {
    expect(parseImageRef("ghcr.io/radiosilence/tfl-mcp:v1.2.0")).toEqual({
      registry: "ghcr.io",
      repository: "radiosilence/tfl-mcp",
      tag: "v1.2.0",
    });
  });

  it("files a bare official image under library/", () => {
    expect(parseImageRef("nginx:1.27")).toEqual({
      registry: "docker.io",
      repository: "library/nginx",
      tag: "1.27",
    });
  });
});

describe("verifyRef", () => {
  const entry = { app: "a", repo: "o/r", path: ["x"], value: "" };

  it("prefers an explicit image, templated", () => {
    expect(
      verifyRef(
        { ...entry, value: "{version}", image: "deluan/navidrome:{version}" },
        "1.2.3",
      ),
    ).toBe("deluan/navidrome:1.2.3");
  });

  it("falls back to the value when it is already a full reference", () => {
    expect(
      verifyRef(
        { ...entry, value: "ghcr.io/radiosilence/tfl-mcp:v{version}" },
        "1.2.0",
      ),
    ).toBe("ghcr.io/radiosilence/tfl-mcp:v1.2.0");
  });

  it("has nothing to check for a bare version, as for a Helm chart", () => {
    expect(
      verifyRef({ ...entry, value: "{version}" }, "34.5.0"),
    ).toBeUndefined();
  });
});

describe("decide", () => {
  const base = { tag: "v1.2.3", next: "1.2.3", ref: undefined, exists: true };

  it("reports a config path that matches nothing rather than dropping the entry", () => {
    expect(decide({ ...base, current: undefined })).toEqual({
      kind: "problem",
      reason: "nothing at the configured path, the config moved",
    });
  });

  it("stays put, without failing the run, when the release exists but its image does not", () => {
    const decision = decide({
      ...base,
      current: "1.2.2",
      ref: "o/r:1.2.3",
      exists: false,
    });
    expect(decision).toEqual({
      kind: "lagging",
      reason:
        "released v1.2.3 but o/r:1.2.3 is not in the registry yet; staying on 1.2.2",
    });
  });

  it("reports a current pin that stopped resolving, even when up to date", () => {
    expect(
      decide({ ...base, current: "1.2.3", ref: "o/r:1.2.3", exists: false }),
    ).toEqual({
      kind: "problem",
      reason: "pinned to o/r:1.2.3, which is not in the registry",
    });
  });

  it("separates the two missing images: only the pinned one is a problem", () => {
    const lagging = decide({
      ...base,
      current: "1.2.2",
      ref: "o/r:1.2.3",
      exists: false,
    });
    const broken = decide({
      ...base,
      current: "1.2.3",
      ref: "o/r:1.2.3",
      exists: false,
    });
    expect([lagging.kind, broken.kind]).toEqual(["lagging", "problem"]);
  });

  it("is up to date when the value already matches", () => {
    expect(decide({ ...base, current: "1.2.3" })).toEqual({
      kind: "up-to-date",
      current: "1.2.3",
    });
  });

  it("updates when the value moved", () => {
    expect(decide({ ...base, current: "1.2.2" })).toEqual({
      kind: "update",
      from: "1.2.2",
      to: "1.2.3",
    });
  });
});

describe("paths against the real config", () => {
  it("resolves every tracked entry to a string", async () => {
    const doc = parseDocument(await config());
    for (const entry of await tracked()) {
      expect(readAt(doc, entry.path), `${entry.app} resolves`).toEqual(
        expect.any(String),
      );
    }
  });

  it("picks a list entry by id rather than position", async () => {
    const doc = parseDocument(await config());
    const path = [
      "config",
      "jaritanet:services",
      "mcp-gateway",
      "mcps",
      { id: "tfl" },
      "image",
    ];
    expect(readAt(doc, path)).toContain("tfl-mcp");
  });

  it("reports a selector matching nothing", async () => {
    const doc = parseDocument(await config());
    expect(
      readAt(doc, [
        "config",
        "jaritanet:services",
        "mcp-gateway",
        "mcps",
        { id: "nope" },
        "image",
      ]),
    ).toBeUndefined();
    expect(
      writeAt(
        doc,
        [
          "config",
          "jaritanet:services",
          "mcp-gateway",
          "mcps",
          { id: "nope" },
          "image",
        ],
        "x",
      ),
    ).toBe(false);
  });
});

describe("rewriting the config", () => {
  it("round-trips an untouched document byte for byte", async () => {
    const raw = await config();
    expect(parseDocument(raw).toString(STRINGIFY_OPTIONS)).toBe(raw);
  });

  it("changes only the line it was asked to change", async () => {
    const raw = await config();
    const doc = parseDocument(raw);
    const path = [
      "config",
      "jaritanet:services",
      "mcp-gateway",
      "mcps",
      { id: "tfl" },
      "image",
    ];

    expect(writeAt(doc, path, "ghcr.io/radiosilence/tfl-mcp:v9.9.9")).toBe(
      true,
    );

    const after = doc.toString(STRINGIFY_OPTIONS).split("\n");
    const changed = raw
      .split("\n")
      .flatMap((line, i) => (line === after[i] ? [] : [i]));
    expect(changed).toHaveLength(1);
    expect(after[changed[0]!]).toContain("v9.9.9");
  });

  it("keeps a quoted scalar quoted, so a version cannot come back as a float", async () => {
    const doc = parseDocument(await config());
    const path = ["config", "jaritanet:traefik", "chartVersion"];

    expect(writeAt(doc, path, "41.0")).toBe(true);

    expect(doc.toString(STRINGIFY_OPTIONS)).toContain('chartVersion: "41.0"');
    expect(readAt(parseDocument(doc.toString(STRINGIFY_OPTIONS)), path)).toBe(
      "41.0",
    );
  });
});

describe("applyTemplate", () => {
  it("substitutes every occurrence", () => {
    expect(applyTemplate("ghcr.io/o/r:v{version}", "1.2.3")).toBe(
      "ghcr.io/o/r:v1.2.3",
    );
    expect(applyTemplate("{version}-{version}", "1")).toBe("1-1");
  });
});
