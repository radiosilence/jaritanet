/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:a9c4f7d140ab1f0d2e76550083ed2bc009215c8f",
  alpine: "alpine:3.21",
} as const;
