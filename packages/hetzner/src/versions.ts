/**
 * Pinned upstreams this package installs on its own.
 *
 * `k3s.version` and `k3s.ciliumVersion` are deliberately not here: they are the
 * cluster rather than something deployed onto it, they must move together, and
 * parsing cross-checks them against `CILIUM_K8S_SUPPORT`. They stay a judgement
 * made in config, with the compatibility matrix open.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  /**
   * Rancher's system-upgrade-controller, which carries `k3s.version` to every
   * node — including ones Pulumi has no SSH to.
   */
  upgradeController: "v0.20.1",
} as const;
