import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";

/**
 * Routes tailnet-bound traffic to the tailnet regardless of packet mark.
 *
 * Cilium stamps the sender's security identity into skb mark bits 16-31 on
 * traffic it hands to the overlay. Tailscale claims mark `0x80000/0xff0000`
 * as "not mine, bypass table 52" and installs policy rules at pref 5210-5250
 * that send matching packets to the main table — which routes them out the
 * default interface. Any pod whose identity has `0x08` as its low byte
 * (identity ≡ 8 mod 256) therefore has its VXLAN packets to the peer's
 * tailnet address silently exit the public interface toward CGNAT space
 * instead of the tunnel. It presents as one specific pod being unreachable
 * across nodes while its neighbours answer, coming and going as identity
 * allocation happens to land on a colliding value — CoreDNS held identity
 * 21000 (0x5208) for days.
 *
 * Neither side has a knob: tailscaled's bypass mark is hardcoded, and
 * Cilium's overlay mark (magic 0x400) carries the identity unconditionally —
 * `enable-identity-mark: false` governs a different path and was measured to
 * change nothing. So the fix is a routing rule at pref 5209, one before the
 * bypass rules: destinations in 100.64.0.0/10 consult the tailnet table
 * first, mark or no mark. tailscaled's own marked packets are unaffected —
 * they go to peers' underlay addresses, never to 100.64/10.
 *
 * A DaemonSet because the rule must hold on every node and does not survive
 * a reboot: each pod asserts it once a minute, which also restores it after
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
            // a node without the rule blackholes a slice of the pod network.
            tolerations: [{ operator: "Exists" }],
            containers: [
              {
                name: app,
                image: "busybox:1.37",
                command: [
                  "sh",
                  "-c",
                  `while true; do ip rule list | grep -q '^5209:' || ip rule add pref 5209 to 100.64.0.0/10 lookup 52; sleep 60; done`,
                ],
                securityContext: {
                  capabilities: { add: ["NET_ADMIN"], drop: ["ALL"] },
                },
                resources: {
                  requests: { cpu: "5m", memory: "8Mi" },
                  limits: { memory: "16Mi" },
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
