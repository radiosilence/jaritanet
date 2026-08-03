import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { SambaConfSchema } from "./samba.schemas.ts";

/** Where a share's hostPath is mounted inside the container. */
const mountPath = (name: string) => `/shares/${name}`;

/** One `[share]` stanza. Leading newline, so the sections separate themselves. */
const shareBlock = (
  share: z.infer<typeof SambaConfSchema>["shares"][number],
) => `
[${share.name}]
  path = ${mountPath(share.name)}
  browseable = yes
  read only = ${share.readOnly ? "yes" : "no"}
  guest ok = yes
  guest only = yes
`;

/**
 * The whole server config, rendered rather than templated by the image.
 *
 * Written out in full so the deploy diff shows what smbd will actually read.
 * The image's own env-var templating is bypassed for the same reason: a share
 * that appears from an environment variable is a share nobody reviewed.
 *
 * `disable netbios` with `smb ports = 445` drops nmbd, 137, 138 and 139
 * entirely. NetBIOS name resolution has been unnecessary since SMB1 died —
 * macOS and Windows both discover over mDNS and WSD now — so the alternative
 * was three more exclusive host ports serving a protocol nothing asks for.
 *
 * `logging = stdout` is the one line that only makes sense in a container, and
 * it is the reason this is worth moving: share access becomes `kubectl logs`
 * rather than a file on a box you have to be inside to read.
 */
export const smbConf = (samba: z.infer<typeof SambaConfSchema>) => `[global]
  workgroup = ${samba.workgroup}
  server string = ${samba.serverString}
  server role = standalone server
  security = user
  # Unknown users become the guest account rather than being rejected, which is
  # what makes these shares anonymous. "Bad User" maps only unknown names; a
  # known name with a bad password still fails.
  map to guest = Bad User
  guest account = ${samba.guestAccount}
  # The control that actually runs. A hostNetwork pod bypasses the CNI, so no
  # NetworkPolicy is in this path.
  hosts allow = ${samba.allowedNetworks.join(" ")}
  server min protocol = SMB2
  # Drops nmbd along with 137, 138 and 139 — see above.
  disable netbios = yes
  smb ports = 445
  load printers = no
  printing = bsd
  printcap name = /dev/null
  disable spoolss = yes
  # Share access is kubectl logs, not a file on the box.
  logging = stdout@1
${samba.shares.map(shareBlock).join("")}`;

/**
 * Anonymous read-only SMB, as a DaemonSet on whichever node holds the disks.
 *
 * A DaemonSet rather than a Deployment for the same reason as the VPN
 * transports: :445 is exclusive, so two replicas can never share a node and
 * "one per matching node" is the shape rather than something an update strategy
 * has to work around. `maxSurge: 0` follows from it — the old pod must be gone
 * before the new one can bind.
 *
 * `nodeLabel` selects the node, so serving files is a property of a machine
 * rather than a hostname written down here. It is required rather than
 * defaulted: whoever labels the node and whoever selects on it must agree
 * exactly, and a selector matching nothing schedules zero pods onto a cluster
 * that reports perfectly healthy.
 *
 * Runs as root with a narrow capability set, not as the media's uid. smbd binds
 * a privileged port and then forks and drops to the guest account per
 * connection, and a capability granted to a non-root container lands in the
 * permitted set but not the ambient one — so a non-root smbd cannot bind :445
 * at all. The same argument xray.ts makes, for the same reason.
 */
export function createSamba(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  samba: z.infer<typeof SambaConfSchema>,
  nodeLabel: string,
  dependsOn: pulumi.Resource[] = [],
) {
  const app = "samba";
  const config = new k8s.core.v1.ConfigMap(
    "samba-config",
    {
      metadata: { name: app, namespace },
      data: { "smb.conf": smbConf(samba) },
    },
    { provider },
  );

  return new k8s.apps.v1.DaemonSet(
    app,
    {
      metadata: { name: app, namespace },
      spec: {
        selector: { matchLabels: { app } },
        // Spelled out because it is load-bearing, not incidental: the host's
        // :445 is exclusive, so the old pod must be deleted before the
        // replacement is created or the new one never binds.
        updateStrategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
        },
        template: {
          metadata: {
            labels: { app },
            // smbd reads its config at exec, so a mounted ConfigMap changing
            // would otherwise never reach the running process.
            annotations: { "jaritanet/config": config.metadata.name },
          },
          spec: {
            // The point of the whole exercise: smbd binds the node's real
            // interfaces, LAN and tailscale0, exactly as the host install did.
            hostNetwork: true,
            // The node's resolver, not the cluster's — clients are on the LAN
            // and the tailnet, neither of which coredns knows about.
            dnsPolicy: "Default",
            automountServiceAccountToken: false,
            nodeSelector: { [nodeLabel]: "true" },
            containers: [
              {
                name: app,
                image: samba.image,
                // The guest account has to exist inside the container and
                // resolve to the uid that owns the media, or every read fails
                // with permission denied on a share that looks correct.
                env: [
                  { name: `ACCOUNT_${samba.guestAccount}`, value: "" },
                  {
                    name: `UID_${samba.guestAccount}`,
                    value: String(samba.guestUid),
                  },
                  {
                    name: `GROUPID_${samba.guestAccount}`,
                    value: String(samba.guestGid),
                  },
                ],
                // A request and no CPU limit, as everywhere else here: CFS
                // throttling on a file server is a stalled transfer rather than
                // a slower one. Memory is a real ceiling — samba forks per
                // connection, and a handful of streams is the normal case.
                resources: {
                  requests: { cpu: "100m" },
                  limits: { memory: "512Mi" },
                },
                volumeMounts: [
                  {
                    name: "config",
                    mountPath: "/etc/samba/smb.conf",
                    subPath: "smb.conf",
                    readOnly: true,
                  },
                  ...samba.shares.map((share) => ({
                    name: `share-${share.name}`,
                    mountPath: mountPath(share.name),
                    readOnly: share.readOnly,
                  })),
                ],
                securityContext: {
                  runAsUser: 0,
                  allowPrivilegeEscalation: false,
                  seccompProfile: { type: "RuntimeDefault" },
                  capabilities: {
                    drop: ["ALL"],
                    add: [
                      // :445 is privileged.
                      "NET_BIND_SERVICE",
                      // smbd forks and drops to the guest account per session.
                      "SETUID",
                      "SETGID",
                    ],
                  },
                },
              },
            ],
            volumes: [
              { name: "config", configMap: { name: config.metadata.name } },
              ...samba.shares.map((share) => ({
                name: `share-${share.name}`,
                hostPath: { path: share.hostPath, type: "Directory" },
              })),
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );
}
