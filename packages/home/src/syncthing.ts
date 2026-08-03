import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { SyncthingConfSchema } from "./syncthing.schemas.ts";

/** Where a folder's hostPath is mounted inside the container. */
const folderPath = (name: string) => `/data/${name}`;

const GUI_PORT = 8384;

/**
 * Syncthing as a DaemonSet on the node holding the disks.
 *
 * A DaemonSet for the reason samba and the transports are: with `hostNetwork`
 * the sync and discovery ports are the host's, so two replicas can never share
 * a node. `maxSurge: 0` follows — the old pod must release them before the new
 * one can bind.
 *
 * Its state is a hostPath rather than a PVC, and the distinction between the
 * two `type`s below is load-bearing. The config directory is
 * `DirectoryOrCreate`, because on first run there is nothing there and
 * syncthing initialises it. The folders are `Directory`, so kubelet refuses to
 * start the pod when a path is missing — which is what happens when the media
 * drive has not mounted. Without that, syncthing would start against an empty
 * mountpoint and interpret every file as deleted, and then propagate that to
 * every paired device. That is the single worst thing this workload can do, and
 * it is prevented by declining to run rather than by noticing afterwards.
 *
 * Requires the shared paths to be *below* the mount point rather than being it:
 * an unmounted `/mnt/kontent` still exists, `/mnt/kontent/music` does not.
 */
export function createSyncthing(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  syncthing: z.infer<typeof SyncthingConfSchema>,
  nodeLabel: string,
  dependsOn: pulumi.Resource[] = [],
) {
  const app = "syncthing";

  new k8s.apps.v1.DaemonSet(
    app,
    {
      metadata: { name: app, namespace },
      spec: {
        selector: { matchLabels: { app } },
        updateStrategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
        },
        template: {
          metadata: { labels: { app } },
          spec: {
            // Local discovery on 21027/udp, so a laptop on the same LAN is
            // found directly. That is not about bandwidth: indexing a large
            // library is thousands of small metadata exchanges, which are
            // latency-bound, and it keeps working with the tailnet down.
            hostNetwork: true,
            dnsPolicy: "Default",
            automountServiceAccountToken: false,
            nodeSelector: { [nodeLabel]: "true" },
            securityContext: {
              // Files syncthing creates have to be owned by whoever owns the
              // media, or navidrome and samba cannot read what it writes.
              // fsGroup would not do it — kubelet does not apply it to hostPath
              // volumes — so the process itself is the right user.
              runAsUser: syncthing.uid,
              runAsGroup: syncthing.gid,
              runAsNonRoot: true,
            },
            containers: [
              {
                name: app,
                image: syncthing.image,
                env: [
                  // The default binds the UI to loopback, which under
                  // hostNetwork is the node's own — unreachable from Traefik,
                  // which runs on the other machine. Syncthing's own GUI
                  // authentication is what protects it; there is no
                  // NetworkPolicy in this path.
                  {
                    name: "STGUIADDRESS",
                    value: `0.0.0.0:${GUI_PORT}`,
                  },
                ],
                ports: [
                  { name: "sync", containerPort: 22000, protocol: "TCP" },
                  { name: "sync-udp", containerPort: 22000, protocol: "UDP" },
                  { name: "discovery", containerPort: 21027, protocol: "UDP" },
                  { name: "gui", containerPort: GUI_PORT, protocol: "TCP" },
                ],
                // A request and no CPU limit: hashing is what syncthing does,
                // and CFS throttling turns a scan that finishes into one that
                // crawls. Memory is a real ceiling, and scales with the number
                // of files rather than their size — a large music library is
                // many small files, which is the expensive shape.
                resources: {
                  requests: { cpu: "200m" },
                  limits: { memory: "1Gi" },
                },
                volumeMounts: [
                  { name: "config", mountPath: "/var/syncthing/config" },
                  ...syncthing.folders.map((folder) => ({
                    name: `folder-${folder.name}`,
                    mountPath: folderPath(folder.name),
                  })),
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  seccompProfile: { type: "RuntimeDefault" },
                  // Nothing here binds a privileged port, so unlike samba there
                  // is no reason to hold a capability at all.
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
            volumes: [
              {
                name: "config",
                // Created on first run; the identity keypair lives here.
                hostPath: {
                  path: syncthing.configPath,
                  type: "DirectoryOrCreate",
                },
              },
              ...syncthing.folders.map((folder) => ({
                name: `folder-${folder.name}`,
                // Deliberately NOT DirectoryOrCreate — see the note above.
                hostPath: { path: folder.hostPath, type: "Directory" },
              })),
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );

  // Named for what createIngressRoute expects, so the web UI can be published
  // on a hostname like anything else rather than reached by port-forward.
  return new k8s.core.v1.Service(
    "syncthing-service",
    {
      metadata: { name: `${app}-service`, namespace },
      spec: {
        ports: [{ port: 80, protocol: "TCP", targetPort: GUI_PORT }],
        selector: { app },
      },
    },
    { provider },
  );
}
