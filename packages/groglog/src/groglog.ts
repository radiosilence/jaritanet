import { createService, type Deployed } from "@jaritanet/k8s";
import type * as k8s from "@pulumi/kubernetes";
import { VERSIONS } from "./versions.ts";

/**
 * GrogLog's website: static bytes behind nano-web, the same shape as blit and
 * the Queen's Head. The image is built by the app's own repository, beside the
 * screenshots it shows.
 */
export function createGroglog(
  provider: k8s.Provider,
  name: string,
  opts: { hostname?: string },
): Deployed {
  createService(provider, name, {
    // Public-facing, so egress is confined to DNS and the internet. No
    // capability dropping, for the same distroless reason as blit.
    networkPolicy: true,
    replicas: 1,
    healthCheck: {},
    resources: {
      requests: { cpu: "10m", memory: "96Mi" },
      limits: { memory: "1Gi" },
    },
    image: {
      repository: "ghcr.io/radiosilence/groglog-site",
      tag: VERSIONS.groglog,
    },
    httpPort: 3000,
  });

  return {
    routes: opts.hostname ? [{ service: name, hostname: opts.hostname }] : [],
  };
}
