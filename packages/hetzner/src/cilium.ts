import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";

/**
 * Cilium as the cluster's CNI.
 *
 * Not optional: k3s is installed with `--flannel-backend=none`, so until this
 * exists the node is NotReady and nothing schedules. That is deliberate —
 * flannel has no policy engine, which is why every NetworkPolicy in this repo
 * was decorative on the old cluster (proved empirically: a pod reached the
 * node's LAN address straight through a policy that denied it).
 *
 * Two settings are load-bearing rather than taste:
 *
 * `kubeProxyReplacement` — Traefik binds hostPort 80/443, and Cilium only
 * implements hostPort when it owns service routing. With kube-proxy in charge
 * instead, hostPort silently does nothing and the ingress path dies. k3s is
 * therefore installed with `--disable-kube-proxy`, which also removes a
 * component rather than running two that overlap.
 *
 * `k8sServiceHost` — with no kube-proxy there is no ClusterIP for the API
 * server yet, so Cilium has to be told where it is directly. It takes the same
 * address the kubeconfig does, because this has to be true on every node rather
 * than only on the one serving the API. Loopback was correct on the control
 * plane and nowhere else: an agent runs no API server, listening on 6444 for
 * the supervisor load balancer instead, so Cilium could not reach an apiserver
 * and the node stayed NotReady with the CNI uninitialised — a failure that
 * reads as a CNI fault while the cause is a value belonging to another machine.
 *
 * That ties this to `apiViaTailnet`: with it on, `apiHost` is a MagicDNS name,
 * and this value has to resolve before there is a CNI — so before CoreDNS, from
 * whatever the host's resolver happens to be. An IP has no such requirement.
 * Turning that flag on is therefore a change to how Cilium bootstraps, not only
 * to how the kubeconfig is addressed.
 */
export function createCilium(
  provider: k8s.Provider,
  version: string,
  apiHost: pulumi.Input<string>,
  dependsOn: pulumi.Resource[] = [],
) {
  return new k8s.helm.v3.Release(
    "cilium",
    {
      chart: "cilium",
      namespace: "kube-system",
      repositoryOpts: { repo: "https://helm.cilium.io/" },
      version,
      values: {
        // Single node — the default of two operator replicas leaves one pending
        // forever, which looks like a broken cluster to anyone reading pods.
        operator: { replicas: 1 },
        // k3s allocates each node a podCIDR, so Cilium can follow that rather
        // than running its own allocator.
        ipam: { mode: "kubernetes" },
        kubeProxyReplacement: true,
        k8sServiceHost: apiHost,
        k8sServicePort: 6443,
        // What Traefik needs; see above.
        hostPort: { enabled: true },
        nodePort: { enabled: true },
        // No `cni` override: k3s with --flannel-backend=none writes no CNI
        // section into containerd's config at all, so containerd falls back to
        // its own defaults — /opt/cni/bin and /etc/cni/net.d — and those are
        // already the chart's defaults too. Pointing Cilium at k3s's own
        // directories (which most k3s+cilium advice still says to do, from
        // before containerd 2.x) installs the plugin somewhere containerd never
        // looks. It fails silently in the worst way: Cilium reports healthy and
        // sets NetworkUnavailable=False while kubelet holds the node NotReady
        // with "cni plugin not initialized" and every pod stays Pending.
      },
    },
    { dependsOn, provider },
  );
}
