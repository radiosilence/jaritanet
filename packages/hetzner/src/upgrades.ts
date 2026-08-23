import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { K3sConfSchema } from "./k3s.schemas.ts";
import { VERSIONS } from "./versions.ts";

const NAMESPACE = "system-upgrade";

/**
 * Rolling k3s upgrades, driven from inside the cluster.
 *
 * The gateway's k3s is installed over SSH, so its version follows this config.
 * A node that joined from a cloud-init seed is installed once and managed by
 * nothing after that: Pulumi has no connection to it, cannot learn its version,
 * and has no mechanism that would ever move it. It sits on whatever was current
 * the day it was flashed.
 *
 * Rancher's system-upgrade-controller closes that gap without needing one.
 * It watches `Plan` CRDs and schedules a privileged Job on each matching node
 * that enters the host's namespace, replaces `/usr/local/bin/k3s` and restarts
 * the unit — so reach comes from cluster membership rather than from a route to
 * the box. `version` therefore stays a single value in `Pulumi.main.yaml`
 * driving both a fresh install and the upgrade of everything already running,
 * and a bump remains a deliberate PR that actually arrives everywhere.
 *
 * Two plans, because servers and agents cannot move at once: the agent plan's
 * `prepare` step blocks on the server plan completing, which is the ordering
 * Kubernetes' own version skew policy requires.
 *
 * The server plan **cordons rather than drains**. The gateway is the only
 * server, so draining it would evict every workload on the cluster to nowhere;
 * cordoning takes it out of scheduling while the unit restarts and leaves the
 * running pods alone. The API is still briefly unavailable during that restart —
 * a real window, but one that outlasts nothing, since the transports are
 * DaemonSet pods that neither cordon nor drain evicts.
 *
 * This upgrades host binaries only. Cilium is a Helm release on a separate path,
 * which is why `K3sConfSchema` asserts the two versions pair rather than
 * trusting that whoever bumps one remembers the other.
 */
export function createK3sUpgrades(
  provider: k8s.Provider,
  k3s: z.infer<typeof K3sConfSchema>,
  dependsOn: pulumi.Resource[] = [],
) {
  const release = `https://github.com/rancher/system-upgrade-controller/releases/download/${VERSIONS.upgradeController}`;

  // Pinned release URLs rather than vendored manifests: the CRD alone is 1300
  // lines of generated schema, and a bump should be a one-line diff for the
  // same reason every other pin in this repo is.
  const crd = new k8s.yaml.v2.ConfigFile(
    "system-upgrade-crd",
    { file: `${release}/crd.yaml` },
    { provider, dependsOn },
  );

  const controller = new k8s.yaml.v2.ConfigFile(
    "system-upgrade-controller",
    { file: `${release}/system-upgrade-controller.yaml` },
    { provider, dependsOn: [...dependsOn, crd] },
  );

  // `upgrade.image` carries no tag on purpose: the controller uses the plan's
  // `version` as the tag, so the two can never name different releases.
  const plan = (name: string, spec: Record<string, unknown>) =>
    new k8s.apiextensions.CustomResource(
      `k3s-upgrade-${name}`,
      {
        apiVersion: "upgrade.cattle.io/v1",
        kind: "Plan",
        metadata: { name: `k3s-${name}`, namespace: NAMESPACE },
        spec: {
          concurrency: 1,
          serviceAccountName: NAMESPACE,
          upgrade: { image: "rancher/k3s-upgrade" },
          version: k3s.version,
          ...spec,
        },
      },
      { provider, dependsOn: [controller] },
    );

  const server = plan("server", {
    cordon: true,
    nodeSelector: {
      matchExpressions: [
        {
          key: "node-role.kubernetes.io/control-plane",
          operator: "In",
          values: ["true"],
        },
      ],
    },
  });

  const agent = plan("agent", {
    // Both spelled out rather than left to the controller's defaults, because
    // both are load-bearing: `kubectl drain` refuses outright on a pod with an
    // emptyDir, and a DaemonSet pod cannot be evicted anywhere — its controller
    // would put it straight back on the cordoned node — so a drain that does
    // not ignore them never completes. That is also what keeps the transports
    // serving while a node they run on upgrades.
    drain: { deleteEmptydirData: true, force: true, ignoreDaemonSets: true },
    nodeSelector: {
      matchExpressions: [
        {
          key: "node-role.kubernetes.io/control-plane",
          operator: "DoesNotExist",
        },
      ],
    },
    prepare: { args: ["prepare", "k3s-server"], image: "rancher/k3s-upgrade" },
  });

  return { agent, controller, crd, server };
}
