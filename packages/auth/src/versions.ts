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
 * Pins that deliberately float, and are therefore absent from `VERSIONS` and
 * from the tracker.
 *
 * Separate rather than merely untracked: the test that every pin is watched is
 * what stops the next ss-rust sitting invisible for a year, so a decision to
 * float has to look different from an oversight. Redis holds one ten-minute
 * nonce per login in flight and nothing else, so chasing its patch releases
 * would be noise — but that is a judgement, and it belongs written down.
 */
export const FLOATING = {
  redis: "redis:8-alpine",
} as const;
