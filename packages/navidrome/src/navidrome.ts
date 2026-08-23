import { createService, type Deployed } from "@jaritanet/k8s";
import type * as k8s from "@pulumi/kubernetes";
import { VERSIONS } from "./versions.ts";

/**
 * Navidrome over the media library, pinned to the box that holds the disks.
 *
 * No configuration surface: 2Ti of media, a uid and two volumes are facts about
 * this deployment rather than knobs, and every one of them was already fixed in
 * a config block nobody varied. What is passed in is only what the stack owns —
 * where it is published, and which machine `lady` is.
 */
export function createNavidrome(
  provider: k8s.Provider,
  name: string,
  opts: { hostname?: string; node: string },
): Deployed {
  createService(provider, name, {
    httpPort: 4533,
    // Public-facing, on the host that holds the media: confine egress to DNS
    // and the public internet, so a bug in it cannot walk to whatever the node
    // is serving and write the library by another route.
    networkPolicy: true,
    // Run as the uid that already owns /data (1001:1002, 0755 on the host),
    // rather than as root borrowing CAP_DAC_OVERRIDE to write a directory it
    // does not own. That is what makes dropping capabilities safe here: the DB
    // is writable by ownership, 4533 needs no NET_BIND_SERVICE, and /music
    // (1000:1000, 0775) stays readable through its other bits.
    //
    // fsGroup is deliberately absent — see SecurityContextSchema. Setting it
    // would hand kubelet ownership management over a 2Ti local PV.
    securityContext: { runAsUser: 1001, runAsGroup: 1002 },
    dropCapabilities: true,
    strategy: { type: "Recreate" },
    image: { repository: "deluan/navidrome", tag: VERSIONS.navidrome },
    env: {
      ND_SCANSCHEDULE: "1h",
      ND_LOGLEVEL: "info",
      ND_SESSIONTIMEOUT: "24h",
      ND_ENABLESHARING: "true",
      ND_ENABLETRANSCODINGCONFIG: "true",
      ND_TRANSCODINGCACHESIZE: "5Gi",
      ND_ENABLEGRAVATAR: "true",
      ND_SCANNER_PURGEMISSING: "always",
      ND_UIWELCOMEMESSAGE: "fuck off",
    },
    healthCheck: {
      path: "/ping",
      initialDelaySeconds: 60,
      periodSeconds: 30,
      timeoutSeconds: 10,
    },
    limits: { cpu: "2000m", memory: "4Gi" },
    persistence: [
      {
        name: "music",
        storage: "2Ti",
        hostPath: "/mnt/kontent/music",
        mountPath: "/music",
        readOnly: true,
        nodeAffinityHostname: opts.node,
      },
      {
        name: "data",
        storage: "20Gi",
        hostPath: "/home/navidrome/data",
        mountPath: "/data",
        readOnly: false,
        nodeAffinityHostname: opts.node,
      },
    ],
  });

  return {
    routes: opts.hostname ? [{ service: name, hostname: opts.hostname }] : [],
  };
}
