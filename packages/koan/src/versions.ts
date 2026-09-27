/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:572190d3313a86002879668d66e4eb4fb45df2ba",
  alpine: "alpine:3.21",
} as const;
