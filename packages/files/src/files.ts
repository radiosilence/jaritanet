import { createService, type Deployed } from "@jaritanet/k8s";
import type * as k8s from "@pulumi/kubernetes";
import { VERSIONS } from "./versions.ts";

/**
 * Static nginx over a read-only mount on the box holding the disks.
 *
 * The guinea pig for ingress restriction (#172): if the CNI drops the kubelet's
 * probes and the pod restart-loops, nobody notices. Extend `restrictIngress` to
 * blit and navidrome only once this has stayed Ready through several probe
 * cycles.
 */
export function createFiles(
  provider: k8s.Provider,
  name: string,
  opts: { hostname?: string; node: string },
): Deployed {
  createService(provider, name, {
    // Serves a read-only mount to the internet and nothing else — it has no
    // business reaching the node, the LAN or another pod. No capability
    // dropping: nginx binds :80 inside the container, which needs
    // NET_BIND_SERVICE even as root once ALL is dropped.
    networkPolicy: true,
    restrictIngress: true,
    strategy: { type: "Recreate" },
    image: {
      repository: "ghcr.io/radiosilence/jaritanet-files",
      tag: VERSIONS.files,
    },
    replicas: 1,
    healthCheck: {
      path: "/",
      initialDelaySeconds: 5,
      periodSeconds: 30,
      timeoutSeconds: 5,
    },
    limits: { cpu: "100m", memory: "64Mi" },
    persistence: [
      {
        name: "files",
        storage: "20Mi",
        hostPath: "/srv/files",
        mountPath: "/srv/files",
        readOnly: true,
        nodeAffinityHostname: opts.node,
      },
    ],
  });

  return {
    routes: opts.hostname ? [{ service: name, hostname: opts.hostname }] : [],
  };
}
