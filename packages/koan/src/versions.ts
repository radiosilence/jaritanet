/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:08e196f486d6737fc962052ee69aa18ae96c64e2",
  alpine: "alpine:3.21",
} as const;
