/**
 * koan follows its releases, bumped by the version updater. Its image is also
 * published per commit on main, for pinning a build between releases by hand.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:v0.36.3",
} as const;

/**
 * Not followed by the version updater. A minor-series tag already carries its
 * own patches, and the image only runs a `chown` before koan starts.
 */
export const UNTRACKED = {
  alpine: "alpine:3.21",
} as const;
