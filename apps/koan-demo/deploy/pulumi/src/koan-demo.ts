import type * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { createKoan } from "@radiosilence/koan-pulumi";
import { VERSIONS } from "./versions.ts";

/**
 * koan's public demo, for visitors and App Review: koan's chart in demo mode
 * over the music this app's image holds. Everyone signs in as demo/demo, and
 * the state is wiped at the top of every hour.
 *
 * Beside the real server in the same namespace, so it carries its own
 * instance name and Service.
 */
export function createKoanDemo(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  opts: { hostname: string; node: string; cpuLimit: string },
) {
  const service = "koan-demo-service";
  createKoan(provider, namespace, {
    name: "koan-demo",
    hostname: opts.hostname,
    demo: {
      enabled: true,
      library: `ghcr.io/radiosilence/koan-demo:${VERSIONS.koanDemo}`,
    },
    resources: {
      requests: { cpu: "50m", memory: "192Mi" },
      limits: { cpu: opts.cpuLimit, memory: "1Gi" },
    },
    nodeSelector: { "kubernetes.io/hostname": opts.node },
    service: { name: service },
    networkPolicy: {
      // kubelet's probes. The API is public anyway, so the port is open to
      // the cluster rather than to a guessed node address.
      extraIngress: [{ ports: [{ protocol: "TCP", port: 4000 }] }],
    },
  });
  // Routes name a prefix; the ingress backs onto `<prefix>-service`.
  return { routes: [{ service: "koan-demo", hostname: opts.hostname }] };
}
