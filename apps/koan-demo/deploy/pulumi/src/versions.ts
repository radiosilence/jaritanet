/**
 * The music image's tag.
 *
 * Released from this repo when `apps/koan-demo/VERSION` changes, and
 * deliberately not read from it — see the note on this repository's containers
 * in `.github/tracked-versions.yml` on why the pin moves only once the image
 * exists.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  koanDemo: "1.1.1",
} as const;
