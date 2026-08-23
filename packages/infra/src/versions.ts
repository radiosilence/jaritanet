/**
 * The decisions behind bumping a tracked component, separated from the IO that
 * feeds them. Everything here is pure, because this is the part that breaks:
 * upstreams spell releases differently, registries lag behind release tags, and
 * the config underneath moves.
 */
import * as z from "zod";

export const TrackedSchema = z.object({
  app: z.string(),
  repo: z.string(),
  /** A `versions.ts`, relative to the repository root. */
  file: z.string().min(1),
  /**
   * The entry in that file's exported `VERSIONS` to rewrite. An identifier,
   * which is what makes the rewrite a plain regex: no escaping, and no way for
   * a key to carry pattern syntax of its own.
   */
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
  value: z.string(),
  image: z.string().optional(),
  tagPrefix: z.string().optional(),
});

export const TrackedListSchema = z.array(TrackedSchema);

export type Tracked = z.infer<typeof TrackedSchema>;

export type Decision =
  | { kind: "up-to-date"; current: string }
  | { kind: "update"; from: string; to: string }
  // Upstream has moved and its image has not caught up. Reported, not failed —
  // see `decide`.
  | { kind: "lagging"; reason: string }
  | { kind: "problem"; reason: string };

/**
 * Upstreams disagree on how a release is spelled — `v3.2.1`, `traefik-34.5.0`.
 * Everything before the first digit goes, and each entry's template puts back
 * whatever form it actually needs.
 */
export const normaliseVersion = (tag: string) => tag.replace(/^\D*/, "");

/**
 * Numeric segment by segment, so `0.1.19` sorts above `0.1.9` — comparing the
 * whole string the ordinary way puts it below, because `1` < `9`.
 */
function compareVersions(a: string, b: string) {
  const partsA = normaliseVersion(a).split(/[.-]/);
  const partsB = normaliseVersion(b).split(/[.-]/);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i] ?? "";
    const partB = partsB[i] ?? "";
    const numA = Number(partA);
    const numB = Number(partB);
    if (
      partA !== "" &&
      partB !== "" &&
      !Number.isNaN(numA) &&
      !Number.isNaN(numB)
    ) {
      if (numA !== numB) return numA - numB;
      continue;
    }
    if (partA !== partB) return partA < partB ? -1 : 1;
  }
  return 0;
}

/**
 * The newest release belonging to one component.
 *
 * The releases API is not reliably newest-first — this repo's own release
 * history for `mariastew` came back with `0.1.9` ahead of `0.1.19` — so this
 * has to sort rather than trust the order it is handed.
 *
 * A repo publishing several things cuts prefixed releases — this one releases
 * `serve-from-env-v1.2.0` and `files-v1.0.0` — and "the latest release" is then
 * repo-wide, so without a prefix an entry would take the version of whatever
 * released most recently and pin itself to an image that was never built.
 */
export const pickLatestTag = (tags: string[], prefix?: string) =>
  (prefix ? tags.filter((tag) => tag.startsWith(prefix)) : tags)
    .toSorted(compareVersions)
    .at(-1);

export const applyTemplate = (template: string, version: string) =>
  template.replaceAll("{version}", version);

/**
 * Splits a reference the way the registry APIs want it. Two or more slashes
 * means the first part is a host; otherwise it is Docker Hub, which files
 * official images under `library/` that a bare name omits.
 */
export function parseImageRef(ref: string) {
  const colon = ref.lastIndexOf(":");
  const tag = ref.slice(colon + 1);
  const name = ref.slice(0, colon);
  const parts = name.split("/");
  if (parts.length > 2) {
    const [registry, ...repository] = parts;
    return { registry, repository: repository.join("/"), tag };
  }
  return {
    registry: "docker.io",
    repository: parts.length === 2 ? name : `library/${name}`,
    tag,
  };
}

/**
 * The reference to confirm in a registry before committing a bump. Defaults to
 * the new value when that is already a full reference, so only entries writing
 * a bare tag need to spell `image` out; a Helm chart has none, and is skipped.
 */
export function verifyRef(entry: Tracked, version: string) {
  if (entry.image) return applyTemplate(entry.image, version);
  const next = applyTemplate(entry.value, version);
  return /\/.*:/.test(next) ? next : undefined;
}

/**
 * The registry is checked even when the entry is already up to date, so a pin
 * that stopped resolving — a release deleted, or one whose image never
 * published in the first place — is reported rather than sitting quietly until
 * the next pod restart finds it.
 *
 * A missing image means two different things depending on which one is missing,
 * and only one of them is ours. A **pinned** ref that has gone is a live
 * deployment referencing something that no longer exists, and needs a human. A
 * **newer** release whose image has not published yet is an upstream mid-flight:
 * klutchell builds unbound's container separately from the release it tracks,
 * and tailscale's ghcr tags trail its GitHub tags by days. Nothing here is
 * wrong, nothing here can act, and the entry simply stays where it is.
 *
 * That distinction is the difference between an alarm and noise. Treating both
 * as failures left this workflow red for a week over two upstreams behaving
 * exactly as they always have, which is the state where nobody reads it any
 * more and the pin that genuinely broke goes out with the tide.
 */
export function decide({
  tag,
  current,
  next,
  ref,
  exists,
}: {
  tag: string;
  current: string | undefined;
  next: string;
  ref: string | undefined;
  exists: boolean;
}): Decision {
  // An empty read means the path matches nothing — a renamed id, or a
  // restructured config. Say so, rather than silently stop tracking it.
  if (!current) {
    return {
      kind: "problem",
      reason: "nothing at the configured path, the config moved",
    };
  }
  if (ref && !exists) {
    return current === next
      ? {
          kind: "problem",
          reason: `pinned to ${ref}, which is not in the registry`,
        }
      : {
          kind: "lagging",
          reason: `released ${tag} but ${ref} is not in the registry yet; staying on ${current}`,
        };
  }
  if (current === next) return { kind: "up-to-date", current };
  return { kind: "update", from: current, to: next };
}

/**
 * One pin inside a package's `versions.ts`, written as `key: "value"`.
 *
 * A regex rather than a TypeScript parse, and what makes that safe is what it
 * insists on: the key must appear exactly once in the file as a quoted string
 * literal. Absent, duplicated, or computed is a miss rather than a guess, and
 * `decide` turns a miss into a reported problem. These files hold pins and
 * nothing else, so there is no second `hysteria:` for it to find.
 */
const pinPattern = (key: string) => `^(\\s*${key}: ")([^"]*)(")`;

export function readConst(source: string, key: string) {
  const all = source.match(new RegExp(pinPattern(key), "gm"));
  if (all?.length !== 1) return undefined;
  return new RegExp(pinPattern(key), "m").exec(source)?.[2];
}

/**
 * Replaces the literal and nothing else, so a bump is one changed line and the
 * docblocks around it are untouched — the same property the YAML writer gets
 * from mutating a scalar in place.
 */
export function writeConst(source: string, key: string, value: string) {
  if (readConst(source, key) === undefined) return undefined;
  return source.replace(
    new RegExp(pinPattern(key), "m"),
    (_, before: string, __: string, after: string) =>
      `${before}${value}${after}`,
  );
}
