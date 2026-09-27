/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:0b9f19abddbba4d40ab99723ca92d7d0b797d97f",
  alpine: "alpine:3.21",
} as const;
