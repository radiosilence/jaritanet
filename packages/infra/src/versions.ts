/**
 * The cluster's own versions: k3s, and the Cilium that is its network.
 *
 * Their minors must pair, which `K3sConfSchema` checks against
 * `CILIUM_K8S_SUPPORT` when `stack.ts` parses them. The version updater moves
 * each to the newest patch of its current minor (`.github/tracked-versions.yml`,
 * by `tagPrefix`); a minor moves by hand, here and in that `tagPrefix`
 * together, with the compatibility row in place. Patches are not optional:
 * Cilium 1.20.0 crash-looped on kernel 7.2+, whose verifier rejects a feature
 * probe that 1.20.2 fixed (cilium/cilium#48016).
 */
export const VERSIONS = {
  k3s: "v1.36.6+k3s1",
  cilium: "1.20.5",
} as const;
