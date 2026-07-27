import * as command from "@pulumi/command";
import type * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { K3sConfSchema } from "../conf.schemas.ts";
import { type Connection, resourcePrefix } from "./vps.ts";

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
  connection: Connection,
  server: hcloud.Server,
  k3s: z.infer<typeof K3sConfSchema>,
  apiHost: pulumi.Input<string>,
  name = "",
) {
  const p = resourcePrefix(name);

  const install = new command.remote.Command(
    `${p}k3s-install`,
    {
      connection,
      create: pulumi.interpolate`set -euo pipefail
# Wait out cloud-init before touching the box. Pulumi SSHes in the moment the
# server answers, which is well before provisioning finishes — so apt is still
# locked (exit 100) and directories these scripts write into do not exist yet.
# Idempotent and instant once boot is done.
cloud-init status --wait >/dev/null 2>&1 || true
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
    --write-kubeconfig-mode 0600" \
  sh -s -
# The installer returns before the API is up; everything downstream reads the
# kubeconfig, so wait for it to actually serve rather than racing it.
for i in $(seq 1 60); do
  k3s kubectl get --raw /readyz >/dev/null 2>&1 && break
  sleep 5
done
k3s kubectl get --raw /readyz >/dev/null`,
      triggers: [k3s.version, pulumi.output(apiHost)],
    },
    { dependsOn: [server] },
  );

  // k3s writes `server: https://127.0.0.1:6443`, which is true on the box and
  // useless anywhere else. Rewritten to the tailnet name the cert already
  // covers, so the config works from CI without disabling verification.
  const raw = new command.remote.Command(
    `${p}k3s-kubeconfig`,
    {
      connection,
      create: "cat /etc/rancher/k3s/k3s.yaml",
      triggers: [install.id],
    },
    { dependsOn: [install] },
  );

  const kubeconfig = pulumi
    .all([raw.stdout, pulumi.output(apiHost)])
    .apply(([cfg, host]) =>
      pulumi.secret(
        cfg.replace("https://127.0.0.1:6443", `https://${host}:6443`),
      ),
    );

  return { install, kubeconfig };
}
