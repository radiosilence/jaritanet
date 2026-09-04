import { createService, type Deployed } from "@jaritanet/k8s";
import type * as k8s from "@pulumi/kubernetes";
import { VERSIONS } from "./versions.ts";

/**
 * A pub's website. Static bytes behind nano-web, same shape as blit — the only
 * difference is whose name is over the door.
 */
export function createQueenshead(
  provider: k8s.Provider,
  name: string,
  opts: { hostname?: string },
): Deployed {
  createService(provider, name, {
    // Public-facing, so confine egress to DNS and the internet. No capability
    // dropping: the image is distroless, so what it needs at runtime cannot be
    // checked from here — the same reasoning as blit, and for the same image.
    networkPolicy: true,
    // One node means one failure domain, so a second replica buys nothing.
    // maxSurge still brings the new pod up before the old one goes.
    replicas: 1,
    healthCheck: {},
    // Matched to blit, which measured 1m CPU and 68Mi serving the same way from
    // the same server. The CPU headroom is for nano-web processing every file
    // before it binds, which under 100m outlasted the liveness probe.
    limits: { cpu: "500m", memory: "192Mi" },
    image: {
      repository: "ghcr.io/radiosilence/qhstrtfrd",
      tag: VERSIONS.queenshead,
    },
    httpPort: 3000,
  });

  return {
    routes: opts.hostname ? [{ service: name, hostname: opts.hostname }] : [],
  };
}
