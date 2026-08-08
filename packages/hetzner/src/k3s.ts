import { remotePreamble } from "@jaritanet/remote";
import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { K3sConfSchema } from "./k3s.schemas.ts";
import { type SshConnection, resourcePrefix } from "./vps.ts";

/**
 * Runs a Kubernetes control plane on the gateway VPS itself, and hands its
 * kubeconfig back to Pulumi.
 *
 * The same `pulumi up` creates the server, installs k3s on it, reads the
 * kubeconfig off the box, and builds the Kubernetes provider from that output —
 * Pulumi's dependency graph does the ordering. No secret round-trip, and no
 * cluster credentials living anywhere a human has to rotate.
 *
 * k3s rather than microk8s: roughly half the memory on a box that also carries
 * xray, hysteria and the workloads; a one-command node join for when the home
 * node arrives; systemd rather than snap, so nothing self-refreshes underneath
 * the VPN.
 *
 * The API server is reachable **only over the tailnet** — `apiHost` is a
 * MagicDNS name, it is in the certificate's SANs, and 6443 is absent from the
 * firewall's inbound rules. That matches how the home cluster was already
 * reached and keeps a control plane off the public internet.
 *
 * `--disable-kube-proxy` is not an optimisation: Cilium only implements
 * hostPort when it owns service routing, and Traefik binds one. Running both
 * would also mean two components doing the same job.
 *
 * Note k3s comes up with **no CNI**: `--flannel-backend=none` is what allows
 * Cilium to own networking, and until Cilium is installed the node is NotReady
 * and pods stay Pending. The API server runs on the host network, so Pulumi can
 * still talk to it and install Cilium — but the two belong in the same deploy.
 */
export function createK3s(
  connection: SshConnection,
  server: hcloud.Server,
  k3s: z.infer<typeof K3sConfSchema>,
  apiHost: pulumi.Input<string>,
  name = "",
  // What the cluster, context and user are called in the kubeconfig handed
  // back. k3s calls all three `default`; this package does not know what the
  // cluster is, so the caller says.
  clusterName = "default",
  // Ordering only: the node's address comes from tailscaled, so it must be up
  // and authenticated before k3s starts.
  dependsOn: pulumi.Resource[] = [],
) {
  const p = resourcePrefix(name);

  // `node-ip` is the box's tailnet address. Cilium tunnels pod traffic to
  // whatever a node reports as its InternalIP, and the home node is behind NAT
  // with no forwarded ports, so its tailnet address is the only one that can be
  // reached at all. Both ends must agree or the encapsulated packets are
  // addressed somewhere they cannot land.
  //
  // Read on the box rather than passed in: this program never learns the
  // address, and reading it here means a node that re-registers with a new one
  // corrects itself on the next deploy instead of silently disagreeing.
  //
  // The public address stays in `tls-san` so the API is still reachable there
  // for CI and for a human whose tailnet is the thing that broke.
  const nodeConfig = new command.remote.Command(
    `${p}k3s-node-config`,
    {
      connection,
      create: pulumi.interpolate`set -euo pipefail
NODE_IP="$(tailscale ip -4 2>/dev/null | head -1)"
if [ -z "$NODE_IP" ]; then
  echo "tailscale reports no IPv4 address — cannot set node-ip" >&2
  exit 1
fi
mkdir -p /etc/rancher/k3s
cat > /etc/rancher/k3s/config.yaml << EOF
node-ip: "$NODE_IP"
tls-san:
  - "${apiHost}"
  - "${server.ipv4Address}"
EOF
# Only meaningful where k3s is already running; on a fresh box the installer
# below reads the file at first start and this is a no-op.
if systemctl is-active --quiet k3s; then
  systemctl restart k3s
fi`,
      triggers: [pulumi.output(apiHost), server.ipv4Address, "node-ip-v1"],
    },
    { dependsOn: [server, ...dependsOn] },
  );

  const install = new command.remote.Command(
    `${p}k3s-install`,
    {
      connection,
      create: pulumi.interpolate`${remotePreamble}
# Cluster DNS upstream. Without this k3s points kubelet — and so coredns —
# at the host's /etc/resolv.conf, which on Ubuntu is systemd-resolved's stub
# at 127.0.0.53. coredns runs in a pod network namespace, where that address
# is its own loopback and nothing answers, so every external name returns
# SERVFAIL and no pod can reach the internet. The host's real resolv.conf is
# no better here: it listed tailscale's MagicDNS, which points at a daemon
# that now lives in a pod.
mkdir -p /etc/rancher/k3s
printf 'nameserver 1.1.1.1\nnameserver 1.0.0.1\n' > /etc/rancher/k3s/resolv.conf
# Idempotent: the installer is a no-op when the pinned version is already there.
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION="${k3s.version}" \
  INSTALL_K3S_EXEC="server \
    --flannel-backend=none \
    --disable-network-policy \
    --disable-kube-proxy \
    --disable=traefik \
    --disable=servicelb \
    --tls-san ${apiHost} \
    --resolv-conf /etc/rancher/k3s/resolv.conf \
    --write-kubeconfig-mode 0600" \
  sh -s -
# k3s ships the standard CNI plugins in data/cni, but writes no CNI section
# into containerd's config when flannel is disabled — so containerd falls back
# to its own default bin dir, /opt/cni/bin, and never looks at k3s's. Cilium
# installs cilium-cni to that default and is fine; every pod sandbox also needs
# loopback, which is not, and without it every pod fails to create its sandbox
# on a node that reports Ready. Symlinks rather than copies, so a k3s upgrade
# moves the plugins and these follow.
mkdir -p /opt/cni/bin
for plugin in /var/lib/rancher/k3s/data/cni/*; do
  ln -sfn "$plugin" "/opt/cni/bin/$(basename "$plugin")"
done
# The installer returns before the API is up, and everything downstream talks
# to it, so wait for it to actually serve rather than racing it.
for i in $(seq 1 60); do
  k3s kubectl get --raw /readyz >/dev/null 2>&1 && break
  sleep 5
done
k3s kubectl get --raw /readyz >/dev/null`,
      triggers: [k3s.version, pulumi.output(apiHost), "resolv-conf-v1"],
    },
    {
      dependsOn: [server, nodeConfig],
      // Whatever the vendor script prints while running as root. Pulumi
      // persists every resource output to state and none of it is worth
      // storing in the clear.
      additionalSecretOutputs: ["stdout"],
    },
  );

  // A read of its own, triggered on the machine rather than on the installer's
  // command line. Pulumi replaces a provider whose configuration changed, and
  // every resource created through it goes with it — Cilium, Services,
  // IngressRoutes, PersistentVolumes. Taking the kubeconfig from the
  // installer's stdout put every edit to the install command on that path,
  // however unrelated, so an ordinary flag change was indistinguishable from a
  // cluster rebuild and only visible to someone reading the preview closely.
  //
  // The server is the trigger because a new server is what mints new
  // credentials: the installer preserves /var/lib/rancher/k3s, so the cluster
  // CA survives any number of reinstalls on the same box. Anything that rotates
  // it out of band — an uninstall, `k3s certificate rotate-ca` — is a bump of
  // the tag, and the cascade that follows is then the real thing.
  const read = new command.remote.Command(
    `${p}k3s-kubeconfig`,
    {
      connection,
      create: "cat /etc/rancher/k3s/k3s.yaml",
      triggers: [server.id, "kubeconfig-v1"],
    },
    {
      dependsOn: [server, install],
      // Cluster-admin client certificate and key. Pulumi persists every
      // resource output to state, so without this it is stored in the clear.
      additionalSecretOutputs: ["stdout"],
    },
  );

  const kubeconfig = pulumi
    .all([read.stdout, pulumi.output(apiHost)])
    .apply(([cfg, host]) =>
      pulumi.secret(renderKubeconfig(cfg, host, clusterName)),
    );

  return { install, kubeconfig };
}

/**
 * Makes k3s's own kubeconfig usable off the box it came from.
 *
 * k3s writes `server: https://127.0.0.1:6443`, true there and useless anywhere
 * else, so it is rewritten to the name the certificate already covers.
 *
 * It also names the cluster, context and user `default`, which collides with
 * every other kubeconfig on the machine reading this — merging one in either
 * clobbers an existing `default` or renames it by hand every time, and
 * `--context default` says nothing about which cluster it reached.
 *
 * The rename is anchored to `: default` at end of line so it cannot match
 * inside the base64 certificate data, where the string can occur by chance. The
 * optional `-` matters: `users:` writes its entry as `- name: default` while
 * `clusters:` indents `name:` under the item, so a pattern expecting only
 * whitespace renames five of the six and leaves the user behind.
 */
export function renderKubeconfig(
  raw: string,
  apiHost: string,
  clusterName: string,
) {
  return raw
    .replace("https://127.0.0.1:6443", `https://${apiHost}:6443`)
    .replace(
      /^(\s*-?\s*(?:name|cluster|user|current-context):\s*)default$/gm,
      `$1${clusterName}`,
    );
}
