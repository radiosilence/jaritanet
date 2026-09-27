/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:6097d533d0930c209e4d1c6c71ae9db8e15b2c02",
  alpine: "alpine:3.21",
} as const;
