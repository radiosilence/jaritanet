/**
 * Released from this repository when `Cargo.toml` changes.
 *
 * A literal rather than a read of that file: it changes when the source does,
 * and this has to change only once an image carrying the version exists to
 * pull. The updater's commit closes the gap, with its registry check as the
 * gate.
 *
 * Rewritten in place by that updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  serveFromEnv: "ghcr.io/radiosilence/serve-from-env:0.1.0",
} as const;
