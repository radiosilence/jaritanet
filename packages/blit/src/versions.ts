/**
 * Pinned to a build rather than a release, which is why it is not in
 * `.github/tracked-versions.yml`: blit cuts no releases, so there is no tag for
 * the updater to follow and this moves by hand.
 *
 * That is a gap rather than a design — it is the one image in the estate
 * nothing watches. It closes when blit gains a release process of its own,
 * which is also what it needs before it can publish its own deploy package.
 */
export const UNTRACKED = {
  blit: "sha-e7ec682",
} as const;
