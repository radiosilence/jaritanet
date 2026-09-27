/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:358ce4e6754d468bf1583b100d4b7d48c5af876b",
  alpine: "alpine:3.21",
} as const;
