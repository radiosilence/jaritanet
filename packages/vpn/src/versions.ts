/**
 * Pinned upstreams for the transports.
 *
 * Here rather than in the stack's config because a pin in two places drifts:
 * every one of these carried a `.default()` on its schema that the live value
 * in `Pulumi.main.yaml` shadowed, and the updater could only see the YAML — so
 * the defaults sat several versions stale, and ss-rust, which had no config
 * entry at all, was tracked by nothing. The image a package deploys is the
 * package's own fact.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  /**
   * Not the project's own GHCR org, which publishes nothing: this is the image
   * hysteria's install docs point at, on a maintainer's Docker Hub account. A
   * weaker supply-chain position, accepted knowingly.
   */
  hysteria: "docker.io/tobyxdd/hysteria:v2.12.2",
  ssRust: "ghcr.io/shadowsocks/ssserver-rust:v1.25.0",
  tailscale: "ghcr.io/tailscale/tailscale:v1.102.3",
  unbound: "docker.io/klutchell/unbound:v1.26.0",
  xray: "ghcr.io/xtls/xray-core:26.3.27",
} as const;

/**
 * The bare core version, for the edge path.
 *
 * `xray-systemd` runs upstream's install script, which takes a version rather
 * than an image — derived from the pin above so the two cannot name different
 * cores, which is what a second entry here would eventually do.
 */
export const XRAY_VERSION = VERSIONS.xray.split(":")[1];
