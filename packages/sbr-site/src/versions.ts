/**
 * Pinned to a build, not a release: the site follows the head of the sbr
 * repository's `main`, which publishes an image for every commit so there is
 * always one to follow.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  sbrSite: "sha-05d5056",
} as const;
