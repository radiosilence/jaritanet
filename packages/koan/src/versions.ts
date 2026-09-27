/**
 * koan is published by commit rather than release: a deploy pins the build it
 * runs, and `main` moves between releases.
 */
export const VERSIONS = {
  koan: "ghcr.io/radiosilence/koan:19762e1cd82c77ff700b87d01dbc04782df3aa17",
  alpine: "alpine:3.21",
} as const;
