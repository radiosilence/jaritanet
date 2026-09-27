/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:14fef606291ce54f43f1c36a9286e7b4e12baa07",
  alpine: "alpine:3.21",
} as const;
