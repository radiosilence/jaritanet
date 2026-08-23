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
    // Measured: 1m CPU and 68Mi for a static site. The old 1000m/1024Mi was a
    // ceiling nobody had looked at, and since a limit without a request becomes
    // the request, two replicas reserved half the node and the scheduler
    // refused a VPN transport for lack of CPU. CPU is 5x the measurement:
    // nano-web processes every file before it binds, which under 100m outlasted
    // the liveness probe.
    limits: { cpu: "500m", memory: "192Mi" },
    image: { repository: "ghcr.io/radiosilence/blit", tag: VERSIONS.blit },
    httpPort: 3000,
  });

  return {
    routes: opts.hostname ? [{ service: name, hostname: opts.hostname }] : [],
  };
}
