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
/**
 * The cluster's pod network: k3s's default `cluster-cidr`, which nothing here
 * overrides. k3s gives each node a /24 of it as its podCIDR.
 */
export const POD_CIDR = "10.42.0.0/16";

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
        operator: {
          replicas: 1,
          prometheus: { enabled: true },
          rollOutPods: true,
        },
        /**
         * Restart the agents when their config changes. Cilium reads
         * `cilium-config` only at startup and the chart does not roll the
         * DaemonSet by default, so a values change otherwise lands in the
         * ConfigMap and nowhere else — the switch to native routing sat
         * unapplied behind agents still tunnelling, with nothing reporting it.
         */
        rollOutCiliumPods: true,
        /**
         * Metrics, on by request rather than by default.
         *
         * The agent's own counters (`:9962`) and Hubble's flow counters
         * (`:9965`) are two servers on the same hostNetwork pod, which is why
         * @jaritanet/metrics scrapes both as static targets on the node rather
         * than discovering them from a `prometheus.io/port` annotation that can
         * only describe one of them.
         *
         * `drop` is the one that pays for the rest. `ServiceArgsSchema` still
         * carries the warning that `networkPolicy` and `restrictIngress` were
         * decorative under flannel; they are enforced under Cilium and have
         * never been verified. `hubble_drop_total{reason="POLICY_DENIED"}` is
         * how that stops being a belief.
         *
         * The enabled list is deliberately short. Every context added to a
         * Hubble metric multiplies its series count, and this runs on the box
         * that also carries the control plane — `httpV2` in particular is a
         * label per path.
         */
        prometheus: { enabled: true },
        hubble: { metrics: { enabled: ["drop", "flow", "tcp", "dns"] } },
        // k3s allocates each node a podCIDR, so Cilium can follow that rather
        // than running its own allocator.
        ipam: { mode: "kubernetes" },
        /**
         * Native routing: pod packets cross nodes as themselves, carried by the
         * tailnet as subnet routes each node advertises for its own podCIDR
         * (see createTailnetRoutes).
         *
         * Not VXLAN, for throughput. The tailnet's tun device takes TCP
         * segmentation offload but not tunnelled GSO, so VXLAN reached
         * tailscaled as one 1230-byte packet at a time — some fifty times the
         * packet rate of the same bytes as host TCP. tailscaled could not drain
         * its queue at that rate, the tun dropped 17% of what was sent into it,
         * and pod-to-pod TCP managed 29 MB/s over a tunnel that carries host
         * traffic at 103 MB/s. Unencapsulated, pod TCP reaches the tun in
         * offloaded batches like any other.
         *
         * `ipv4NativeRoutingCIDR` keeps pod-to-pod traffic unmasqueraded, so it
         * arrives with the source address NetworkPolicy matches on.
         */
        routingMode: "native",
        ipv4NativeRoutingCIDR: POD_CIDR,
        /**
         * Through the kernel's routing rather than BPF's FIB lookup. The route
         * to another node's pods lives in tailscaled's table 52 behind policy
         * rules, out a layer-3 device Cilium does not manage; the kernel stack
         * is the path those rules were written for.
         */
        bpf: { hostLegacyRouting: true },
        /**
         * Pod MTU, set rather than detected: the tailnet's 1280.
         *
         * Detection was wrong under VXLAN — Cilium handed pods the tunnel's
         * 1280 and then added its own header, and the oversized packets dropped
         * with no ICMP to trigger path-MTU discovery. Small requests answered
         * and anything larger hung; CoreDNS never finished listing services, so
         * every pod on that node resolved nothing. Stated, so that failure does
         * not depend on detection again.
         */
        MTU: 1280,
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
