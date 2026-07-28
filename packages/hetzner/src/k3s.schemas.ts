import * as z from "zod";

/**
 * A Kubernetes control plane on the VPS itself, so one `pulumi up` creates the
 * box, installs k3s and deploys into it — replacing an ansible → CI secrets →
 * workflow round-trip.
 *
 * `cilium` is not optional in practice: k3s is installed with
 * `--flannel-backend=none` so Cilium can own networking, which means the node
 * stays NotReady until Cilium is deployed. It is also the whole point — flannel
 * has no policy engine, so every NetworkPolicy is inert under it
 * (see docs/architecture.md).
 *
 * Cilium's version has to match the cluster's: 1.19 supports k8s 1.33–1.36,
 * 1.18 supports 1.30–1.33. Moving `version` without checking that is how you
 * get a cluster with no working network.
 */
export const K3sConfSchema = z.object({
  /**
   * Reach the API server over the tailnet rather than the public IP.
   *
   * The tailnet is the better answer — a control plane with no public listener
   * at all — but it puts an ephemeral CI node's ability to join a mesh on the
   * critical path of every deploy, and that has proven flaky. With this off the
   * kubeconfig points at the public IP and the firewall opens 6443, which is
   * how most managed clusters expose it: TLS with client-cert auth, no
   * anonymous access.
   *
   * The certificate covers whichever is chosen, so verification is real either
   * way — this never falls back to skipping TLS checks.
   */
  apiViaTailnet: z.boolean().default(false),
  ciliumVersion: z.string().default("1.19.6"),
  version: z.string().default("v1.36.2+k3s1"),
});
