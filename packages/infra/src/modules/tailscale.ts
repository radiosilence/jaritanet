import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { TailnetConfSchema } from "../conf.schemas.ts";
import { VPN_ENTRY_LABEL } from "../util.ts";

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
 * State lives in a Kubernetes Secret rather than on the host. The host path was
 * right for the migration off systemd — it already held the identity, so the
 * node rejoined as itself — but it tied that identity to one box's disk, which
 * is the opposite of what a cluster whose nodes are reprovisionable should do.
 * In a Secret the state survives the node.
 *
 * The Secret is created here, empty, so the Role can name it. RBAC cannot scope
 * `create` to a resource name, so a container that made its own would need
 * create on every Secret in the namespace — which is where the VPN credentials
 * and the Postgres passwords live. Pre-creating it costs one resource and keeps
 * the grant to get/update/patch on exactly one object. `ignoreChanges` on the
 * contents because containerboot owns them from then on; Pulumi would otherwise
 * blank the node key on every deploy.
 *
 * Losing the tailnet when the cluster breaks is accepted: sshd on the public IP
 * is the way back in, so nothing here is built to defend against it.
 *
 * `authKey` is an OAuth client secret (`tskey-client-...`, auth_keys scope plus
 * the tag), used directly as the auth key — those don't hit the 90-day expiry
 * raw auth keys do. OAuth-minted keys default to ephemeral, so `ephemeral=false`
 * is required to keep the relay node persistent.
 */
export function createTailscale(
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

  // Created empty and never written by Pulumi again — see the note above.
  const state = new k8s.core.v1.Secret(
    "tailscale-state",
    { metadata: { name: "tailscale-state", namespace } },
    { provider, ignoreChanges: ["data", "stringData"] },
  );

  const account = new k8s.core.v1.ServiceAccount(
    "tailscale",
    { metadata: { name: app, namespace } },
    { provider },
  );

  const role = new k8s.rbac.v1.Role(
    "tailscale",
    {
      metadata: { name: app, namespace },
      rules: [
        {
          apiGroups: [""],
          resources: ["secrets"],
          // By name: this pod terminates traffic from hostile networks, so a
          // compromise should not read every other Secret in the namespace.
          resourceNames: [state.metadata.name],
          verbs: ["get", "update", "patch"],
        },
      ],
    },
    { provider },
  );

  new k8s.rbac.v1.RoleBinding(
    "tailscale",
    {
      metadata: { name: app, namespace },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: role.metadata.name,
      },
      subjects: [
        { kind: "ServiceAccount", name: account.metadata.name, namespace },
      ],
    },
    { provider },
  );

  return new k8s.apps.v1.DaemonSet(
    app,
    {
      metadata: { name: app, namespace },
      spec: {
        selector: { matchLabels: { app } },
        // The DaemonSet default, spelled out because it is load-bearing: there
        // is one tailscale0 and one state directory per host, so the old pod
        // must be deleted before the replacement is created (maxSurge 0).
        updateStrategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
        },
        template: {
          metadata: { labels: { app } },
          spec: {
            hostNetwork: true,
            // Cluster DNS, not the host's: the state Secret is reached at
            // kubernetes.default.svc, a name only coredns knows. "Default"
            // was right while state lived on disk and the only lookups were
            // tailscale's own control plane; it fails the moment the pod
            // needs the API, with "lookup kubernetes.default.svc on 1.1.1.1:
            // no such host". WithHostNet is the hostNetwork variant — plain
            // ClusterFirst is silently ignored here.
            dnsPolicy: "ClusterFirstWithHostNet",
            // Needed now: the state Secret is reached through the API. The
            // Role behind this token covers one Secret by name.
            serviceAccountName: account.metadata.name,
            // A relay is a property of the node, not of the cluster — the same
            // label that decides which node serves the transports.
            nodeSelector: { [VPN_ENTRY_LABEL]: "true" },
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
                  // Node state in the cluster rather than on the node's disk.
                  // TS_STATE_DIR is deliberately absent: setting both is
                  // ambiguous, and the directory is the thing being moved away
                  // from.
                  { name: "TS_KUBE_SECRET", value: state.metadata.name },
                  // Kernel networking, not userspace: this node relays traffic
                  // for others rather than originating it, so it needs a real
                  // interface the host routes through.
                  { name: "TS_USERSPACE", value: "false" },
                  { name: "TS_ACCEPT_DNS", value: "false" },
                  // The node persists in the state Secret, so re-running `up`
                  // on every restart only risks churning a working node.
                  { name: "TS_AUTH_ONCE", value: "true" },
                  {
                    name: "TS_EXTRA_ARGS",
                    value: `--advertise-tags=${tailnet.tag} --accept-routes=false --ssh=false`,
                  },
                ],
                // Request, not limit, for the same reason as the transports:
                // every 100x flow a client sends into the mesh is encrypted
                // here, and CFS throttling would show up as the tailnet going
                // intermittently slow. 100m is a floor for a relay that is
                // mostly idle and occasionally carries a file copy.
                //
                // 256Mi: wireguard state is per-peer and this tailnet is small,
                // but containerboot runs tailscaled plus its own supervision,
                // and an OOM here takes the mesh down rather than a request.
                resources: {
                  requests: { cpu: "100m" },
                  limits: { memory: "256Mi" },
                },
                volumeMounts: [{ name: "tun", mountPath: "/dev/net/tun" }],
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
