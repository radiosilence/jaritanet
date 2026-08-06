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
 * This replaces a three-way dance: ansible generated a service account on the
 * home box, pushed the token to GitHub secrets, and a later workflow read it
 * back as KUBE_HOST/KUBE_TOKEN. Here the same `pulumi up` creates the server,
 * installs k3s on it, reads the kubeconfig off the box, and builds the
 * Kubernetes provider from that output — Pulumi's dependency graph does the
 * ordering. No secret round-trip, and no cluster credentials living anywhere a
 * human has to rotate.
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
) {
  const p = resourcePrefix(name);

  const install = new command.remote.Command(
    `${p}k3s-install`,
    {
      connection,
      create: pulumi.interpolate`set -euo pipefail
# Pulumi SSHes in the moment the server answers, which is long before the box
# is actually usable. Two separate waits are needed:
#   1. cloud-init, or directories these scripts write into do not exist yet;
#   2. the dpkg lock, because Ubuntu runs unattended-upgrades *after* cloud-init
#      finishes and holds it for minutes — every apt call here exits 100 until
#      it lets go, and the vendor install scripts give no way to pass a timeout.
# Both are idempotent and return immediately once the box has settled.
cloud-init status --wait >/dev/null 2>&1 || true
# Ubuntu runs unattended-upgrades once cloud-init finishes and holds the dpkg
# lock for minutes; every apt call exits 100 until it lets go. Telling apt
# itself to wait is the only approach that also covers the vendor install
# scripts (xray, hysteria), which shell out to apt with no flags we can pass.
# A polling loop here cannot help those, and fuser is not even installed on
# the minimal cloud image anyway.
mkdir -p /etc/apt/apt.conf.d
printf 'DPkg::Lock::Timeout "600";\n' > /etc/apt/apt.conf.d/99-lock-timeout
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
# The installer returns before the API is up; everything downstream reads the
# kubeconfig, so wait for it to actually serve rather than racing it.
for i in $(seq 1 60); do
  k3s kubectl get --raw /readyz >/dev/null 2>&1 && break
  sleep 5
done
k3s kubectl get --raw /readyz >/dev/null
# Printed last so it is this command's stdout: the config and the cluster it
# describes then come from the same execution.
cat /etc/rancher/k3s/k3s.yaml`,
      // The resolv-conf tag is part of the trigger because changing the
      // command text alone does not re-run a remote command.
      triggers: [k3s.version, pulumi.output(apiHost), "resolv-conf-v1"],
    },
    {
      dependsOn: [server],
      // This command's stdout ends with the kubeconfig, which carries a
      // cluster-admin client certificate and key. Pulumi persists every
      // resource output to state, so without this it is stored in the clear.
      additionalSecretOutputs: ["stdout"],
    },
  );

  // The kubeconfig is the install command's own stdout, not a separate read.
  // As two resources they could disagree: reinstalling k3s regenerates its CA,
  // but a read whose trigger had not changed kept serving the old one — which
  // presents as "x509: certificate signed by unknown authority" against a
  // cluster that is up and reachable. One execution cannot drift from itself.
  //
  // k3s writes `server: https://127.0.0.1:6443`, true on the box and useless
  // anywhere else, so it is rewritten to the name the cert already covers.
  //
  // It also names the cluster, context and user `default`, which collides with
  // every other kubeconfig on the machine reading this — merging one in either
  // clobbers an existing `default` or renames it by hand every time, and
  // `--context default` says nothing about which cluster it reached. Renamed
  // here rather than after the fact for the same reason the address is: the
  // output should be usable as it comes out.
  //
  // Anchored to `: default` at end of line so it cannot match inside the
  // base64 certificate data, where the string can occur by chance. The optional
  // `-` matters: `users:` writes its entry as `- name: default` while `clusters:`
  // indents `name:` under the item, so a pattern expecting only whitespace
  // renames five of the six and leaves the user behind.
  const kubeconfig = pulumi
    .all([install.stdout, pulumi.output(apiHost)])
    .apply(([cfg, host]) =>
      pulumi.secret(
        cfg
          .slice(cfg.indexOf("apiVersion:"))
          .replace("https://127.0.0.1:6443", `https://${host}:6443`)
          .replace(
            /^(\s*-?\s*(?:name|cluster|user|current-context):\s*)default$/gm,
            `$1${clusterName}`,
          ),
      ),
    );

  return { install, kubeconfig };
}
