import { VERSIONS } from "./versions.ts";

/**
 * koan's public demo, for visitors and App Review: the configuration for
 * koan's chart in demo mode over the music this app's image holds. Everyone
 * signs in as demo/demo, and the state is wiped at the top of every hour.
 *
 * Configuration rather than a call to the chart, so the stack's one pin of
 * `@radiosilence/koan-pulumi` deploys both servers and the demo runs the
 * release the real server does. Beside it in the same namespace, so it carries
 * its own instance name and Service.
 */
export function koanDemo(opts: {
  hostname: string;
  node: string;
  cpuLimit: string;
}) {
  return {
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
    service: { name: "koan-demo-service" },
    networkPolicy: {
      // kubelet's probes. The API is public anyway, so the port is open to
      // the cluster rather than to a guessed node address.
      extraIngress: [{ ports: [{ protocol: "TCP" as const, port: 4000 }] }],
    },
  };
}
