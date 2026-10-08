import { createService, type Deployed } from "@jaritanet/k8s";
import type * as k8s from "@pulumi/kubernetes";
import { VERSIONS } from "./versions.ts";

/**
 * The public site. A static bundle behind nano-web, and the only workload here
 * whose image is pinned to a commit.
 */
export function createBlit(
  provider: k8s.Provider,
  name: string,
  opts: { hostname?: string },
): Deployed {
  createService(provider, name, {
    // Public-facing, so confine egress to DNS and the internet. No capability
    // dropping: the image is distroless, so what it needs at runtime cannot be
    // checked from here, and guessing that is what took Navidrome down
    // (see #166/#168).
    networkPolicy: true,
    // One node means one failure domain: a second replica dies with the first,
    // so it bought nothing. maxSurge still brings the new pod up before the old
    // one goes, so deploys stay seamless.
    replicas: 1,
    healthCheck: {},
    // nano-web processes every file before it binds, which under a 100m CPU
    // limit outlasted the liveness probe; with no CPU limit it takes what is
    // idle.
    resources: {
      requests: { cpu: "10m", memory: "128Mi" },
      limits: { memory: "1Gi" },
    },
    image: { repository: "ghcr.io/radiosilence/blit", tag: VERSIONS.blit },
    httpPort: 3000,
  });

  return {
    routes: opts.hostname ? [{ service: name, hostname: opts.hostname }] : [],
  };
}
