/**
 * The Kubernetes minors each Cilium minor is e2e tested against, inclusive.
 *
 * Source: `Documentation/network/kubernetes/requirements.rst` on Cilium's
 * release branch for that minor. Cilium's wording is that anything newer
 * "depends on the backward compatibility offered by Kubernetes" — so a pairing
 * outside this table is untested rather than certainly broken, which is exactly
 * the state that is invisible until something in the datapath misbehaves.
 *
 * Add a row when bumping to a Cilium minor that has no entry. An unknown minor
 * fails rather than passes: the table's value is that it cannot be silently
 * outgrown.
 */
export const CILIUM_K8S_SUPPORT: Record<string, [string, string]> = {
  "1.17": ["1.29", "1.32"],
  "1.18": ["1.30", "1.33"],
  "1.19": ["1.31", "1.34"],
  "1.20": ["1.33", "1.36"],
};

/**
 * Both projects version as `major.minor.patch` with decoration on either side —
 * `v1.36.2+k3s1`, `1.19.6` — and only the first two components decide
 * compatibility.
 */
const minorOf = (version: string) => {
  const m = /(\d+)\.(\d+)/.exec(version);
  return m
    ? { key: `${m[1]}.${m[2]}`, ord: Number(m[1]) * 1000 + Number(m[2]) }
    : undefined;
};

/**
 * Whether a Cilium version is tested against the Kubernetes a k3s version
 * carries, as a message describing the mismatch or `undefined` when they pair.
 *
 * The two versions travel through entirely separate machinery — `version` ends
 * up as an install argument and an upgrade Plan, `ciliumVersion` as a Helm chart
 * version — so nothing downstream can notice they disagree. The failure that
 * produces is a cluster that comes up looking healthy and moves no packets,
 * which is worth a red preview rather than a discovery.
 */
export function checkCiliumSupport(ciliumVersion: string, k3sVersion: string) {
  const cilium = minorOf(ciliumVersion);
  const k8s = minorOf(k3sVersion);
  if (!cilium) return `cilium version ${ciliumVersion} has no major.minor`;
  if (!k8s) return `k3s version ${k3sVersion} has no major.minor`;

  const range = CILIUM_K8S_SUPPORT[cilium.key];
  if (!range) {
    return `cilium ${cilium.key} is not in the support table (${Object.keys(CILIUM_K8S_SUPPORT).join(", ")}) — add its tested Kubernetes range from that release's requirements.rst`;
  }

  const [min, max] = range;
  const lo = minorOf(min)?.ord ?? 0;
  const hi = minorOf(max)?.ord ?? 0;
  if (k8s.ord < lo || k8s.ord > hi) {
    return `cilium ${cilium.key} is tested against Kubernetes ${min}–${max}, but k3s ${k3sVersion} is ${k8s.key} — bump both together`;
  }

  return undefined;
}
