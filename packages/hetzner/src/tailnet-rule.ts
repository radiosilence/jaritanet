import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { POD_CIDR } from "./cilium.ts";

/**
 * Routes tailnet-bound traffic to the tailnet regardless of packet mark.
 *
 * Cilium stamps the sender's security identity into skb mark bits 16-31 on
 * traffic it hands across nodes. Tailscale claims mark `0x80000/0xff0000`
 * as "not mine, bypass table 52" and installs policy rules at pref 5210-5250
 * that send matching packets to the main table — which routes them out the
 * default interface. Any pod whose identity has `0x08` as its low byte
 * (identity ≡ 8 mod 256) therefore had its packets to the other node silently
 * exit the public interface instead of the tunnel. It presents as one specific
 * pod being unreachable across nodes while its neighbours answer, coming and
 * going as identity allocation happens to land on a colliding value — CoreDNS
 * held identity 21000 (0x5208) for days.
 *
 * Neither side has a knob: tailscaled's bypass mark is hardcoded, and
 * Cilium's overlay mark (magic 0x400) carries the identity unconditionally —
 * `enable-identity-mark: false` governs a different path and was measured to
 * change nothing. So the fix is routing rules ahead of the bypass rules:
 * destinations in 100.64.0.0/10 (pref 5209) and in the pod network (5208)
 * consult the tailnet table first, mark or no mark. The pod network's routes
 * there are the other nodes' podCIDRs (see createTailnetRoutes); a node's own
 * is absent, so local pod traffic falls through to the main table as before.
 * tailscaled's own marked packets are unaffected — they go to peers' underlay
 * addresses, never to either range.
 *
 * A DaemonSet because the rules must hold on every node and do not survive
 * a reboot: each pod asserts them once a minute, which also restores them after
 * tailscaled reinstalls its own rules. hostNetwork for the host's netns,
 * NET_ADMIN and nothing else.
 */
export function createTailnetRule(
  provider: k8s.Provider,
  dependsOn: pulumi.Resource[] = [],
) {
  const app = "tailnet-rule";
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
            // Every node, including the control plane and anything cordoned:
            // a node without the rules blackholes a slice of the pod network.
            tolerations: [{ operator: "Exists" }],
            containers: [
              {
                name: app,
                image: "busybox:1.37",
                command: [
                  "sh",
                  "-c",
                  `while true
do
  ip rule list | grep -q '^5208:' || ip rule add pref 5208 to ${POD_CIDR} lookup 52
  ip rule list | grep -q '^5209:' || ip rule add pref 5209 to 100.64.0.0/10 lookup 52
  sleep 60
done`,
                ],
                securityContext: {
                  capabilities: { add: ["NET_ADMIN"], drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "10m", memory: "32Mi" },
                  limits: { memory: "1Gi" },
                },
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );
}
