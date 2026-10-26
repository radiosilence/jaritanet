import { createService, type Deployed } from "@jaritanet/k8s";
import type * as k8s from "@pulumi/kubernetes";
import { VERSIONS } from "./versions.ts";

/**
 * sbr's website and its app's privacy policy: static bytes behind nano-web,
 * the same shape as koan.rocks. The image is built by the sbr repository from
 * its `site/` directory, beside the benchmarks its charts are drawn from.
 */
export function createSbrSite(
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
    // Not yet measured: a handful of pages, held in memory by nano-web.
    resources: {
      requests: { cpu: "10m", memory: "64Mi" },
      limits: { memory: "1Gi" },
    },
    image: {
      repository: "ghcr.io/radiosilence/sbr-site",
      tag: VERSIONS.sbrSite,
    },
    httpPort: 3000,
  });

  return {
    routes: opts.hostname ? [{ service: name, hostname: opts.hostname }] : [],
  };
}
