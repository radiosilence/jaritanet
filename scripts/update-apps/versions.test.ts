import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  holdsImage,
  bumpPatch,
  chartServes,
  applyTemplate,
  decide,
  normaliseVersion,
  parseImageRef,
  pickLatestTag,
  readBase,
  readConst,
  readDependency,
  readTarget,
  targetFile,
  TrackedListSchema,
  verifyRef,
  writeBase,
  writeConst,
  writeDependency,
} from "./versions.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const tracked = async () =>
  TrackedListSchema.parse(
    parse(
      await readFile(join(ROOT, ".github", "tracked-versions.yml"), "utf8"),
    ),
  );

type Entries = Awaited<ReturnType<typeof tracked>>;

/** Every file an entry rewrites, of any kind, keyed by its repo path. */
const targetSources = async (entries: Entries) => {
  const files = [...new Set(entries.map(targetFile))];
  const texts = await Promise.all(
    files.map((f) => readFile(join(ROOT, f), "utf8")),
  );
  return new Map(files.map((f, i) => [f, texts[i]!]));
};

describe("holdsImage", () => {
  const image = (os: string, architecture: string) => ({
    platform: { os, architecture },
  });

  it("takes a single image's manifest", () => {
    expect(holdsImage({ schemaVersion: 2, config: {}, layers: [] })).toBe(true);
  });

  it("takes an index listing images", () => {
    expect(
      holdsImage({
        manifests: [image("linux", "amd64"), image("linux", "arm64")],
      }),
    ).toBe(true);
  });

  it("refuses an index listing nothing, as a tag published ahead of its images is", () => {
    expect(holdsImage({ manifests: [] })).toBe(false);
  });

  it("refuses an index listing only attestations", () => {
    expect(holdsImage({ manifests: [image("unknown", "unknown")] })).toBe(
      false,
    );
  });
});

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
  const entry = { app: "a", repo: "o/r", file: "f.ts", key: "k", value: "" };

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

describe("targets against the real tree", () => {
  it("resolves every tracked entry to a string", async () => {
    const entries = await tracked();
    const sources = await targetSources(entries);
    for (const entry of entries) {
      const current = readTarget(entry, sources.get(targetFile(entry))!);
      expect(current, `${entry.app} resolves`).toEqual(expect.any(String));
    }
  });

  it("releases every tracked base image with a version it can bump", async () => {
    const entries = await tracked();
    for (const entry of entries) {
      if (!("release" in entry)) continue;
      const version = await readFile(join(ROOT, entry.release), "utf8");
      expect(bumpPatch(version), entry.release).toEqual(expect.any(String));
    }
  });

  /**
   * The gap this closes is not hypothetical: `blit` is pinned to a git SHA and
   * tracked by nothing, and ss-rust was invisible for as long as its pin lived
   * in a schema default. A pin nobody watches is only discovered when it breaks.
   */
  it("tracks every pin in every package versions.ts", async () => {
    const entries = await tracked();
    const pinned = entries.filter((e) => "file" in e);
    const sources = await targetSources(pinned);
    for (const [file, source] of sources) {
      const watched = new Set(
        pinned.flatMap((e) => ("file" in e && e.file === file ? [e.key] : [])),
      );
      // `VERSIONS` only. A pin that deliberately floats lives in `UNTRACKED`,
      // which is the point of the two being separate consts — a decision not to
      // track has to be visible, and an oversight still has to fail here.
      const pins = /export const VERSIONS = \{([\s\S]*?)^\} as const;/m.exec(
        source,
      )?.[1];
      expect(pins, `${file} exports VERSIONS`).toEqual(expect.any(String));
      for (const [, key] of pins!.matchAll(/^\s{2}(\w+): "/gm)) {
        expect(watched.has(key!), `${file}: ${key} is tracked`).toBe(true);
      }
    }
  });
});

describe("rewriting a package pin", () => {
  const source = [
    "export const VERSIONS = {",
    '  hysteria: "docker.io/tobyxdd/hysteria:v2.12.2",',
    '  unbound: "docker.io/klutchell/unbound:v1.26.0",',
    "} as const;",
    "",
    "export const DERIVED = `x${VERSIONS.hysteria}`;",
  ].join("\n");

  it("reads a pin", () => {
    expect(readConst(source, "unbound")).toBe(
      "docker.io/klutchell/unbound:v1.26.0",
    );
  });

  it("changes exactly one line", () => {
    const next = writeConst(source, "hysteria", "docker.io/x/y:v9")!;
    const changed = next
      .split("\n")
      .filter((line, i) => line !== source.split("\n")[i]);
    expect(changed).toEqual(['  hysteria: "docker.io/x/y:v9",']);
  });

  /** A miss has to be reportable, not a silent no-op that claims a bump. */
  it("reports a key that is not there", () => {
    expect(readConst(source, "nope")).toBeUndefined();
    expect(writeConst(source, "nope", "x")).toBeUndefined();
  });

  it("refuses a key appearing twice rather than guessing which", () => {
    const doubled = `${source}\n  hysteria: "other",`;
    expect(readConst(doubled, "hysteria")).toBeUndefined();
  });
});

describe("rewriting a base image", () => {
  const dockerfile = [
    "FROM rust:1.90 AS build",
    "RUN cargo build",
    "",
    "FROM nginx:1.31.7-alpine",
    "COPY nginx.conf /etc/nginx/nginx.conf",
  ].join("\n");

  it("reads the FROM of the named image only", () => {
    expect(readBase(dockerfile, "nginx")).toBe("nginx:1.31.7-alpine");
    expect(readBase(dockerfile, "rust")).toBe("rust:1.90");
  });

  it("changes exactly that line", () => {
    const next = writeBase(dockerfile, "nginx", "nginx:1.31.9-alpine")!;
    const changed = next
      .split("\n")
      .filter((line, i) => line !== dockerfile.split("\n")[i]);
    expect(changed).toEqual(["FROM nginx:1.31.9-alpine"]);
  });

  it("leaves a comment quoting the same reference alone", () => {
    const quoted = `# was FROM nginx:1.31.7-alpine\n${dockerfile}`;
    const next = writeBase(quoted, "nginx", "nginx:1.31.9-alpine")!;
    expect(next.split("\n")[0]).toBe("# was FROM nginx:1.31.7-alpine");
    expect(readBase(next, "nginx")).toBe("nginx:1.31.9-alpine");
  });

  it("refuses an image it cannot find, or finds twice", () => {
    expect(writeBase(dockerfile, "redis", "redis:8")).toBeUndefined();
    const twice = `${dockerfile}\nFROM nginx:1.30.0-alpine`;
    expect(readBase(twice, "nginx")).toBeUndefined();
  });

  it("bumps a release's patch", () => {
    expect(bumpPatch("1.0.2\n")).toBe("1.0.3");
    expect(bumpPatch("1.0.9")).toBe("1.0.10");
    expect(bumpPatch("1.0")).toBeUndefined();
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

describe("rewriting a dependency", () => {
  const manifest = [
    "{",
    '  "dependencies": {',
    '    "@radiosilence/mcp-gateway-pulumi": "0.8.1",',
    '    "zod": "4.4.3"',
    "  }",
    "}",
  ].join("\n");

  it("reads a dependency's version", () => {
    expect(readDependency(manifest, "@radiosilence/mcp-gateway-pulumi")).toBe(
      "0.8.1",
    );
  });

  it("changes exactly one line", () => {
    const next = writeDependency(
      manifest,
      "@radiosilence/mcp-gateway-pulumi",
      "0.9.0",
    )!;
    const changed = next
      .split("\n")
      .filter((line, i) => line !== manifest.split("\n")[i]);
    expect(changed).toEqual([
      '    "@radiosilence/mcp-gateway-pulumi": "0.9.0",',
    ]);
  });

  /** A scope's `@` and `/` are matched literally, not as pattern syntax. */
  it("does not treat the package name as a regex", () => {
    expect(
      readDependency(manifest, "@radiosilence/mcp.gateway-pulumi"),
    ).toBeUndefined();
  });

  it("reports a dependency that is not there", () => {
    expect(readDependency(manifest, "left-pad")).toBeUndefined();
    expect(writeDependency(manifest, "left-pad", "1.0.0")).toBeUndefined();
  });
});

describe("chartServes", () => {
  const index = { entries: { traefik: [{ version: "41.6.1" }] } };

  it("accepts a version the index lists", () => {
    expect(chartServes(index, "traefik", "41.6.1")).toBe(true);
  });

  it("rejects a released version the index lacks", () => {
    expect(chartServes(index, "traefik", "41.7.0")).toBe(false);
  });

  it("rejects an unknown chart or a malformed index", () => {
    expect(chartServes(index, "other", "41.6.1")).toBe(false);
    expect(chartServes(null, "traefik", "41.6.1")).toBe(false);
  });
});
