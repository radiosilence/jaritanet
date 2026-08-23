/**
 * Pinned to a build, not a release.
 *
 * blit is a website: a typo fix should reach it without a version bump, so its
 * images are tagged by commit and this follows the head of `main`. The updater
 * resolves that itself rather than blit reaching in here and rewriting it,
 * which is what it used to do — and what broke the moment this repository's
 * config became TypeScript.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  blit: "sha-3db1953",
} as const;
