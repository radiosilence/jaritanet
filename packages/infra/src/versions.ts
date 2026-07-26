/**
 * The decisions behind bumping a tracked component, separated from the IO that
 * feeds them. Everything here is pure, because this is the part that breaks:
 * upstreams spell releases differently, registries lag behind release tags, and
 * the config underneath moves.
 */
import { type Document, isMap, isScalar, isSeq } from "yaml";
import * as z from "zod";

/**
 * A key, or a selector picking a list entry by one of its fields. `{ id: tfl }`
 * finds that MCP wherever it sits in the list, so reordering the list is
 * harmless.
 */
const PathSegmentSchema = z.union([
  z.string(),
  z.record(z.string(), z.string()),
]);

export const TrackedSchema = z.object({
  app: z.string(),
  repo: z.string(),
  path: z.array(PathSegmentSchema).min(1),
  value: z.string(),
  image: z.string().optional(),
});

export const TrackedListSchema = z.array(TrackedSchema);

export type Tracked = z.infer<typeof TrackedSchema>;

/**
 * Chosen so an untouched document round-trips byte-for-byte. Left to its
 * defaults the serialiser re-wraps long strings and pads flow collections,
 * which would bury a one-line version bump in an unrelated reformat of the
 * whole file.
 */
export const STRINGIFY_OPTIONS = {
  lineWidth: 0,
  flowCollectionPadding: false,
} as const;

export type Decision =
  | { kind: "up-to-date"; current: string }
  | { kind: "update"; from: string; to: string }
  | { kind: "problem"; reason: string };

/**
 * Upstreams disagree on how a release is spelled — `v3.2.1`, `traefik-34.5.0`.
 * Everything before the first digit goes, and each entry's template puts back
 * whatever form it actually needs.
 */
export const normaliseVersion = (tag: string) => tag.replace(/^\D*/, "");

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
    return {
      kind: "problem",
      reason:
        current === next
          ? `pinned to ${ref}, which is not in the registry`
          : `released ${tag} but ${ref} is not in the registry; staying on ${current}`,
    };
  }
  if (current === next) return { kind: "up-to-date", current };
  return { kind: "update", from: current, to: next };
}

/**
 * Turns each selector segment into the list index it currently matches, giving
 * a path the document can address directly.
 */
export function resolvePath(doc: Document, path: Tracked["path"]) {
  const resolved: (string | number)[] = [];
  for (const segment of path) {
    if (typeof segment === "string") {
      resolved.push(segment);
      continue;
    }
    const [field, wanted] = Object.entries(segment)[0] ?? [];
    const list = doc.getIn(resolved);
    if (field === undefined || !isSeq(list)) return undefined;
    const index = list.items.findIndex(
      (item) => isMap(item) && item.get(field) === wanted,
    );
    if (index < 0) return undefined;
    resolved.push(index);
  }
  return resolved;
}

export function readAt(doc: Document, path: Tracked["path"]) {
  const resolved = resolvePath(doc, path);
  const value = resolved && doc.getIn(resolved);
  return typeof value === "string" ? value : undefined;
}

/**
 * Mutates the existing scalar rather than replacing it, so the value keeps
 * whatever quoting it was written with. Without that an unquoted `41.0` would
 * come back as a float on the next read.
 */
export function writeAt(doc: Document, path: Tracked["path"], value: string) {
  const resolved = resolvePath(doc, path);
  const node = resolved && doc.getIn(resolved, true);
  if (!isScalar(node)) return false;
  node.value = value;
  return true;
}
