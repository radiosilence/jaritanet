/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:c2ab642dbd0b0e1d806b5892dbde8d68d309e351",
  alpine: "alpine:3.21",
} as const;
