/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:6fdac4554d1c79cc656e23a36f155997b1f29626",
  alpine: "alpine:3.21",
} as const;
