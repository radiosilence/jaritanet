/**
 * A literal rather than a read of `apps/mariastew/Cargo.toml`, and the gap
 * between the two is the point.
 *
 * The app's version changes when its source does; this changes when an image
 * carrying that version exists to pull. Derive one from the other and a bump
 * merged before the container workflow finishes is a deploy of a tag that was
 * never published. The release process closes that gap by moving this in its
 * own commit, after the build — which is what the version updater does, with
 * the registry check as the gate.
 *
 * Rewritten in place by that updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  mariastew: "ghcr.io/radiosilence/mariastew:0.1.29",
} as const;
