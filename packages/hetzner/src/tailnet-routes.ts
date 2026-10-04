import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";

/**
 * Has every node advertise its own podCIDR to the tailnet and accept the
 * others', which is what carries pod traffic between nodes now that Cilium
 * routes natively rather than over VXLAN (see createCilium).
 *
 * Tailscale delivers only packets addressed to a tailnet IP or an approved
 * subnet route, so each node's /24 has to be a route: advertised by that node,
 * approved by the policy's `autoApprovers` (see buildTailnetPolicy), and
 * accepted by every other node. `--snat-subnet-routes=false` keeps the pod's
 * own source address on arrival; masqueraded to the node's, NetworkPolicy
 * would match every cross-node packet against the wrong peer.
 *
 * The podCIDR is read from the host's routing table rather than the Node
 * object: the route Cilium installs to its own pods via `cilium_host` is the
 * one containing that device's address. It exists under either routing mode,
 * and reading it needs no API access, so this has no CNI to wait for beyond
 * Cilium having started. Until then the loop finds nothing and tries again.
 *
 * `tailscale set` changes only the prefs it names and is idempotent, so the
 * loop asserting it every 30 seconds also restores them after a `tailscale up
 * --reset` (see createTailscaleSystemd) or a node rejoining.
 */
export function createTailnetRoutes(
  provider: k8s.Provider,
  image: string,
  dependsOn: pulumi.Resource[] = [],
) {
  const app = "tailnet-routes";
  return new k8s.apps.v1.DaemonSet(
    app,
    {
      metadata: { name: app, namespace: "kube-system" },
      spec: {
        selector: { matchLabels: { app } },
        template: {
          metadata: { labels: { app } },
          spec: {
            hostNetwork: true,
            dnsPolicy: "Default",
            automountServiceAccountToken: false,
            // Every node: one that does not advertise its podCIDR is
            // unreachable from the others' pods.
            tolerations: [{ operator: "Exists" }],
            containers: [
              {
                name: app,
                image,
                command: [
                  "sh",
                  "-c",
                  `while true; do
  host=$(ip -4 -o addr show cilium_host 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }')
  cidr=$(ip -4 route show dev cilium_host 2>/dev/null | awk -v h="$host" '
    function n(s, o) { split(s, o, "."); return ((o[1] * 256 + o[2]) * 256 + o[3]) * 256 + o[4] }
    $1 ~ /\\// { split($1, c, "/"); b = 2 ^ (32 - c[2]); if (int(n(c[1]) / b) == int(n(h) / b)) print $1 }')
  if [ -n "$cidr" ]; then
    tailscale set --advertise-routes="$cidr" --accept-routes=true --snat-subnet-routes=false
  fi
  sleep 30
done`,
                ],
                volumeMounts: [
                  { name: "tailscaled", mountPath: "/var/run/tailscale" },
                ],
                resources: {
                  requests: { cpu: "5m", memory: "16Mi" },
                  limits: { memory: "64Mi" },
                },
              },
            ],
            // tailscaled runs on the host, outside the cluster, so its local
            // API socket is the only way in.
            volumes: [
              {
                name: "tailscaled",
                hostPath: { path: "/var/run/tailscale", type: "Directory" },
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );
}
