import * as tailscale from "@pulumi/tailscale";
import type * as pulumi from "@pulumi/pulumi";

/**
 * What the cluster's dataplane needs from the policy.
 *
 * Cilium addresses both nodes by tailnet IP (#238) and routes pod traffic
 * natively over the tailnet, so the policy decides whether either arrives. The
 * kubelet port carries logs and exec, which is what makes a partition look like
 * a healthy cluster you cannot inspect; the pod network carries everything
 * else.
 *
 * The protocol is stated rather than left to Tailscale's TCP default so a test
 * says which traffic it asserts.
 */
const KUBELET = { port: 10250, proto: "tcp" };
const POD_PROBE = { port: 443, proto: "tcp" };

type TailnetPolicyArgs = {
  /** Tailnet IPs of nodes the cluster's dataplane must reach. */
  clusterPeers: string[];
  /** Who may apply the tags — `tagOwners` values, e.g. `["you@example.com"]`. */
  owners: string[];
  /** Every tag any node in the fleet advertises. */
  tags: string[];
  /**
   * The cluster's pod network and the tags of the nodes that advertise it, one
   * podCIDR each (see createTailnetRoutes).
   */
  podNetwork?: { cidr: string; routers: string[] };
};

/** An address inside `cidr`, for a test to name: its first host. */
const firstHost = (cidr: string) => {
  const octets = cidr.split("/")[0].split(".").map(Number);
  octets[3] += 1;
  return octets.join(".");
};

/**
 * Builds the tailnet policy document.
 *
 * Generated rather than checked in as a literal so the rules track the topology
 * that has to satisfy them. `tags` comes from what the fleet actually
 * advertises, which removes the ordering hazard that a hand-edited policy has:
 * a node cannot advertise a tag the policy does not define, so pointing a node
 * at a new tag and defining that tag can no longer be two separate acts that
 * land in the wrong order.
 *
 * `tests` is the reason this matters more than tidiness. The provider validates
 * a top-level `tests` block *before* it applies anything, so asserting the node
 * pair here turns a grant that would partition the cluster into a failed
 * `pulumi up`. Without it nothing notices until pods time out while every one of
 * them reports healthy — and none of that is visible from the admin console,
 * which is the argument for the policy living beside the code that depends on
 * it.
 *
 * `autoApprovers` is what keeps the pod network free of a console step: a node
 * advertising its podCIDR is approved on the spot, and only the cluster's own
 * tag may, and only inside the pod network. Nodes accept routes because of it,
 * so it is also what bounds what they can be handed.
 *
 * Emitted as JSON, which is valid HuJSON. Comments are lost, so the reasoning
 * lives here instead — beside the code that derives a rule rather than beside a
 * literal copy of it.
 */
export function buildTailnetPolicy({
  clusterPeers,
  owners,
  tags,
  podNetwork,
}: TailnetPolicyArgs) {
  // The gateway and every edge advertise the same tag, so the union arrives
  // with duplicates. Sorted so a reordered config is not a policy diff.
  const fleetTags = [...new Set(tags)].toSorted();

  return {
    tagOwners: Object.fromEntries(fleetTags.map((tag) => [tag, owners])),
    // Unrestricted, as the tailnet has always been. Narrowing this is a
    // separate act with its own reasoning (#239) — representation and
    // behaviour do not change in the same step.
    acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
    // Tailscale SSH, which reaches only devices with an owner. Both servers are
    // tagged and so have none; break-glass is sshd on the public IP.
    ssh: [
      {
        action: "check",
        src: ["autogroup:member"],
        dst: ["autogroup:self"],
        users: ["autogroup:nonroot", "root"],
      },
    ],
    nodeAttrs: [{ target: ["autogroup:member"], attr: ["funnel"] }],
    ...(podNetwork && {
      autoApprovers: { routes: { [podNetwork.cidr]: podNetwork.routers } },
    }),
    tests: fleetTags.flatMap((tag) => [
      ...clusterPeers.map((peer) => ({
        src: tag,
        proto: KUBELET.proto,
        accept: [`${peer}:${KUBELET.port}`],
      })),
      ...(podNetwork && clusterPeers.length
        ? [
            {
              src: tag,
              proto: POD_PROBE.proto,
              accept: [`${firstHost(podNetwork.cidr)}:${POD_PROBE.port}`],
            },
          ]
        : []),
    ]),
  };
}

/**
 * Manages the tailnet's policy file as code.
 *
 * The tailnet is the last line of defence for anything that reaches the
 * gateway: the gateway is a member so it can relay `100.x` over the tunnel, so
 * whatever it may reach, a bug at the Xray or Hysteria layer may also reach.
 * #162 was exactly that — guest routing rules that looked like they blocked the
 * tailnet but did not, because IP rules never matched domain destinations. A
 * grant limiting what the gateway can talk to would have contained it without
 * anyone noticing the bug.
 *
 * It cuts the other way too, which the containment argument alone misses: pod
 * traffic between nodes crosses the tailnet, so this policy carries it. A grant
 * that omits the node pair or the pod network does not degrade access, it
 * partitions the cluster.
 *
 * `overwriteExistingContent` is deliberately left false. The provider then
 * refuses to touch a policy it has not imported, so this cannot clobber a
 * hand-maintained tailnet — the import is a conscious step, not a surprise, and
 * has to precede the first deploy rather than follow it. See README.
 */
export function createTailnetPolicy({
  clientId,
  clientSecret,
  tailnet,
  ...policy
}: TailnetPolicyArgs & {
  clientId: pulumi.Input<string>;
  clientSecret: pulumi.Input<string>;
  tailnet: string;
}) {
  const provider = new tailscale.Provider("tailscale", {
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
    tailnet,
  });

  return new tailscale.Acl(
    "tailnet-policy",
    {
      acl: [
        "// Generated by Pulumi from packages/infra/src/tailnet-policy.ts.",
        "// Edits made here are reverted on the next deploy.",
        JSON.stringify(buildTailnetPolicy(policy), null, 2),
      ].join("\n"),
    },
    { provider },
  );
}
