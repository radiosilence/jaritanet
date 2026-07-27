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
 * server yet, so Cilium has to be told where it is directly. It is on this same
 * node, hence loopback.
 */
export function createCilium(
  provider: k8s.Provider,
  version: string,
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
        k8sServiceHost: "127.0.0.1",
        k8sServicePort: 6443,
        // What Traefik needs; see above.
        hostPort: { enabled: true },
        nodePort: { enabled: true },
        // k3s keeps its CNI plugins and config outside the usual /opt and /etc
        // locations, and Cilium writes its conflist to whatever it is told.
        cni: {
          binPath: "/var/lib/rancher/k3s/data/current/bin",
          confPath: "/var/lib/rancher/k3s/agent/etc/cni/net.d",
        },
      },
    },
    { dependsOn, provider },
  );
}
