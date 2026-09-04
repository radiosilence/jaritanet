/**
 * Pinned to a build, not a release.
 *
 * queenshead is a website: a corrected opening time should reach it without a
 * version bump, so its images are tagged by commit and this follows the head of
 * `main`. The updater resolves that itself.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  queenshead: "sha-6cc4faf",
} as const;
