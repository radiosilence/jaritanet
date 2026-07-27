import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { TailnetConfSchema } from "../conf.schemas.ts";

const IMAGE = "ghcr.io/tailscale/tailscale:v1.98.9";

/**
 * Joins the gateway to the tailnet from inside its own cluster, so it can relay
 * client traffic into the mesh.
 *
 * `hostNetwork` is what makes this equivalent to the systemd unit it replaces:
 * tailscale0 has to exist in the *host's* network namespace, because the things
 * that dial 100.x — xray and hysteria, both hostNetwork too — resolve their
 * routes there. A pod-local interface would route nothing.
 *
 * `--accept-routes=false` is load-bearing: a peer advertising an exit node or
 * routes must not be able to swallow the VPS default route, or the relay (and
 * every service riding it) goes dark. `--ssh=false` is explicit rather than
 * omitted, so a re-run definitely clears it. `TS_ACCEPT_DNS=false` for the same
 * class of reason — with hostNetwork, accepting MagicDNS would rewrite the
 * node's /etc/resolv.conf, and this box resolves through its own unbound.
 *
 * State lives on the host at the path the systemd tailscaled already used, so
 * a gateway migrating from that keeps its node identity instead of registering
 * a second machine. It is also why the migration must stop tailscaled without
 * logging it out (see gateway.ts).
 *
 * Losing the tailnet when the cluster breaks is accepted: sshd on the public IP
 * is the way back in, so nothing here is built to defend against it.
 *
 * `authKey` is an OAuth client secret (`tskey-client-...`, auth_keys scope plus
 * the tag), used directly as the auth key — those don't hit the 90-day expiry
 * raw auth keys do. OAuth-minted keys default to ephemeral, so `ephemeral=false`
 * is required to keep the relay node persistent.
 */
export function createTailscalePod(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  tailnet: z.infer<typeof TailnetConfSchema>,
  authKey: pulumi.Output<string>,
  dependsOn: pulumi.Resource[] = [],
) {
  const secret = new k8s.core.v1.Secret(
    "tailscale-authkey",
    {
      metadata: { name: "tailscale-authkey", namespace },
      stringData: {
        authkey: pulumi.interpolate`${authKey}?ephemeral=false&preauthorized=true`,
      },
    },
    { provider },
  );

  const app = "tailscale";
  return new k8s.apps.v1.Deployment(
    app,
    {
      metadata: { name: app, namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app } },
        // One tailscale0 and one state directory on the host, so the old pod
        // has to be gone before the new one starts.
        strategy: { type: "Recreate" },
        template: {
          metadata: { labels: { app } },
          spec: {
            hostNetwork: true,
            // The host's resolver is unbound on this same box, not the cluster.
            dnsPolicy: "Default",
            automountServiceAccountToken: false,
            containers: [
              {
                name: app,
                image: IMAGE,
                env: [
                  {
                    name: "TS_AUTHKEY",
                    valueFrom: {
                      secretKeyRef: {
                        name: secret.metadata.name,
                        key: "authkey",
                      },
                    },
                  },
                  { name: "TS_HOSTNAME", value: tailnet.hostname },
                  { name: "TS_STATE_DIR", value: "/var/lib/tailscale" },
                  // Kernel networking, not userspace: this node relays traffic
                  // for others rather than originating it, so it needs a real
                  // interface the host routes through.
                  { name: "TS_USERSPACE", value: "false" },
                  { name: "TS_ACCEPT_DNS", value: "false" },
                  // The node persists in the state directory, so re-running
                  // `up` on every restart only risks churning a working node.
                  { name: "TS_AUTH_ONCE", value: "true" },
                  {
                    name: "TS_EXTRA_ARGS",
                    value: `--advertise-tags=${tailnet.tag} --accept-routes=false --ssh=false`,
                  },
                ],
                resources: { limits: { memory: "256Mi" } },
                volumeMounts: [
                  { name: "state", mountPath: "/var/lib/tailscale" },
                  { name: "tun", mountPath: "/dev/net/tun" },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  seccompProfile: { type: "RuntimeDefault" },
                  capabilities: {
                    drop: ["ALL"],
                    // Creating tailscale0 and writing the routes it needs.
                    add: ["NET_ADMIN"],
                  },
                },
              },
            ],
            volumes: [
              {
                name: "state",
                hostPath: {
                  path: "/var/lib/tailscale",
                  type: "DirectoryOrCreate",
                },
              },
              {
                name: "tun",
                hostPath: { path: "/dev/net/tun", type: "CharDevice" },
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );
}
