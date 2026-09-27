/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:609e51c63dead2da64246959138a87af483e0de1",
  alpine: "alpine:3.21",
} as const;
