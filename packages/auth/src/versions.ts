/**
 * Pinned images for the identity provider.
 *
 * A literal, moved by the release process after the image exists — see the note
 * in `@jaritanet/mariastew` on why this does not read the app's `Cargo.toml`.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  auth: "ghcr.io/radiosilence/auth:0.2.0",
} as const;

/**
 * Pins the updater deliberately does not watch, and why — see the same const in
 * `@radiosilence/mcp-gateway-pulumi`. Redis holds one ten-minute nonce per login in
 * flight and nothing else, so chasing its patch releases would be noise.
 */
export const UNTRACKED = {
  redis: "redis:8-alpine",
} as const;
