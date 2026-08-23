import * as z from "zod";
import { checkCiliumSupport } from "./compat.ts";

/**
 * A Kubernetes control plane on the VPS itself, so one `pulumi up` creates the
 * box, installs k3s and deploys into it.
 *
 * `cilium` is not optional in practice: k3s is installed with
 * `--flannel-backend=none` so Cilium can own networking, which means the node
 * stays NotReady until Cilium is deployed. It is also the whole point — flannel
 * has no policy engine, so every NetworkPolicy is inert under it
 * (see docs/architecture.md).
 *
 * Cilium's version has to match the cluster's, and the two reach the fleet by
 * entirely separate paths — `version` as an install argument and an upgrade
 * Plan against the nodes, `ciliumVersion` as a Helm chart version against the
 * cluster — so nothing downstream is in a position to notice they disagree.
 * `CILIUM_K8S_SUPPORT` holds the table and parsing enforces it, which makes a
 * half-bump a red preview rather than a cluster that comes up healthy and moves
 * no packets.
 */
export const K3sConfSchema = z
  .object({
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
    ciliumVersion: z.string().default("1.20.0"),
    version: z.string().default("v1.36.3+k3s1"),
  })
  // `.check` rather than `.superRefine`: the latter wraps the object in a pipe,
  // which makes every field look reused to `z.toJSONSchema` and turns the
  // generated schema into `$ref`s for no gain.
  .check((ctx) => {
    const problem = checkCiliumSupport(
      ctx.value.ciliumVersion,
      ctx.value.version,
    );
    if (problem) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: problem,
        path: ["ciliumVersion"],
      });
    }
  });
