/**
 * Pinned to a build, not a release: the site follows the head of the koan
 * repository's `main`, which publishes an image for every commit so there is
 * always one to follow.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  koanSite: "sha-44ee54b",
} as const;
