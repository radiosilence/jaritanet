/**
 * A bare tag: `ServiceArgsSchema` wants the repository and the tag apart.
 *
 * Released from this repo when `apps/files/VERSION` changes, and deliberately
 * not read from it — see the note on this repository's containers in
 * `.github/tracked-versions.yml` on why the pin moves only once the image
 * exists.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  files: "1.0.2",
} as const;
