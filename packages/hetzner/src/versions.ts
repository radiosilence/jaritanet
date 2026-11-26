/**
 * Pinned upstreams this package installs on its own.
 *
 * `k3s.version` and `k3s.ciliumVersion` are not here: they are the cluster
 * rather than something deployed onto it, their minors must move together, and
 * parsing cross-checks them against `CILIUM_K8S_SUPPORT`. They live in
 * `infra/src/versions.ts`, where the updater moves their patches.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  /**
   * Rancher's system-upgrade-controller, which carries `k3s.version` to every
   * node — including ones Pulumi has no SSH to.
   */
  upgradeController: "v0.21.1",
} as const;
