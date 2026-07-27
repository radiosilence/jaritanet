import * as k8s from "@pulumi/kubernetes";
import type * as z from "zod";
import type { HealthCheckConfigSchema } from "./healthcheck.schemas.ts";
import type { ServiceArgsSchema } from "./service.schemas.ts";

const annotations = {
  "pulumi.com/skipAwait": "false",
};

// A k8s httpGet probe from the health-check config. Liveness/readiness/startup
// share the same shape; startup passes a larger failureThreshold to tolerate a
// slow first boot.
const probe = (
  hc: z.infer<typeof HealthCheckConfigSchema>,
  httpPort: number,
  failureThreshold = hc.failureThreshold,
) => ({
  httpGet: {
    path: hc.path,
    port: hc.port ?? httpPort,
    ...(hc.httpHeaders.length > 0 && { httpHeaders: hc.httpHeaders }),
  },
  initialDelaySeconds: hc.initialDelaySeconds,
  periodSeconds: hc.periodSeconds,
  timeoutSeconds: hc.timeoutSeconds,
  failureThreshold,
  successThreshold: hc.successThreshold,
});

export function createService(
  provider: k8s.Provider,
  serviceName: string,
  {
    dropCapabilities,
    env,
    healthCheck,
    hostVolumes,
    httpPort,
    image,
    limits,
    networkPolicy,
    persistence,
    ports,
    replicas,
    securityContext,
    strategy,
  }: z.infer<typeof ServiceArgsSchema>,
) {
  const pvs = Object.fromEntries(
    persistence.map(
      ({
        name: key,
        storageClassName,
        readOnly,
        storage,
        nodeAffinityHostname,
        hostPath,
      }) => [
        key,
        new k8s.core.v1.PersistentVolume(
          `${serviceName}-${key}-pv`,
          {
            metadata: {
              annotations,
            },
            spec: {
              accessModes: readOnly ? ["ReadOnlyMany"] : ["ReadWriteMany"],
              capacity: {
                storage,
              },
              local: {
                path: hostPath,
              },
              nodeAffinity: {
                required: {
                  nodeSelectorTerms: [
                    {
                      matchExpressions: [
                        {
                          key: "kubernetes.io/hostname",
                          operator: "In",
                          values: [nodeAffinityHostname],
                        },
                      ],
                    },
                  ],
                },
              },
              persistentVolumeReclaimPolicy: "Delete",
              storageClassName,
              volumeMode: "Filesystem",
            },
          },
          { provider },
        ),
      ],
    ),
  );

  const pvcs = Object.fromEntries(
    persistence
      .filter(({ name }) => Boolean(pvs[name]))
      .map(({ name: key, storageClassName, readOnly, storage }) => [
        key,
        new k8s.core.v1.PersistentVolumeClaim(
          `${serviceName}-${key}-pvc`,
          {
            metadata: {
              annotations,
            },
            spec: {
              accessModes: readOnly ? ["ReadOnlyMany"] : ["ReadWriteMany"],
              resources: { requests: { storage } },
              storageClassName,
              volumeName: pvs[key]?.metadata.name,
            },
          },
          { provider },
        ),
      ]),
  );

  const service = new k8s.core.v1.Service(
    `${serviceName}-service`,
    {
      metadata: {
        annotations,
        name: `${serviceName}-service`,
      },
      spec: {
        ports: [
          {
            protocol: "TCP",
            port: 80,
            targetPort: httpPort,
          },
        ],
        selector: { app: serviceName },
      },
    },
    { provider },
  );

  // Writable mounts only, and only when the pod runs as a specific uid — those
  // are exactly the paths whose existing contents can be owned by someone else.
  const writable = [...hostVolumes, ...persistence].filter((v) => !v.readOnly);
  const ownershipFixes =
    securityContext?.runAsUser === undefined
      ? []
      : writable.map((v) => v.mountPath);
  const ownershipMounts = ownershipFixes.length
    ? writable.map(({ name, mountPath }) => ({ name, mountPath }))
    : [];

  const probes = healthCheck
    ? {
        ...(healthCheck.enableLiveness && {
          livenessProbe: probe(healthCheck, httpPort),
        }),
        ...(healthCheck.enableReadiness && {
          readinessProbe: probe(healthCheck, httpPort),
        }),
        // Startup gets 3× the failure budget (min 30) so a cold boot isn't
        // killed before it's ready.
        ...(healthCheck.enableStartup && {
          startupProbe: probe(
            healthCheck,
            httpPort,
            Math.max(healthCheck.failureThreshold * 3, 30),
          ),
        }),
      }
    : {};

  new k8s.apps.v1.Deployment(
    `${serviceName}-deployment`,
    {
      metadata: {
        annotations,
      },
      spec: {
        replicas,
        selector: {
          matchLabels: { app: serviceName },
        },
        strategy,
        template: {
          metadata: {
            annotations,
            labels: { app: serviceName },
          },
          spec: {
            // None of these talk to the API server, so the token is a free
            // foothold for anything that lands in the container.
            automountServiceAccountToken: false,
            ...(ownershipFixes.length && {
              // A service that switches to running as a given uid inherits
              // directories created by whatever it ran as before — Navidrome's
              // /data was root-owned inside, so it opened its DB fine (the
              // mount point matched) and then died on a root-owned cache
              // subdirectory. Ownership of the mount point says nothing about
              // its contents, and nothing outside the cluster is going to fix
              // that on a rebuilt host.
              //
              // Read-only mounts are excluded, which is load-bearing: chown -R
              // across a 2Ti music library on every pod start is not a thing
              // anyone wants, and a read-only mount would reject it anyway.
              initContainers: [
                {
                  name: "fix-ownership",
                  image: "busybox:1.37",
                  command: [
                    "sh",
                    "-c",
                    // Only touches what is already wrong, so a correct tree
                    // costs a stat pass rather than a full rewrite.
                    ownershipFixes
                      .map(
                        (path) =>
                          `find ${path} ! -user ${securityContext?.runAsUser} -exec chown ${securityContext?.runAsUser}:${securityContext?.runAsGroup} {} +`,
                      )
                      .join(" && "),
                  ],
                  // Overrides the pod-level uid, and keeps the capabilities
                  // chown needs — the app container is the one that gets to be
                  // unprivileged.
                  securityContext: {
                    runAsUser: 0,
                    allowPrivilegeEscalation: false,
                  },
                  volumeMounts: ownershipMounts,
                },
              ],
            }),
            containers: [
              {
                name: serviceName,
                image: `${image.repository}:${image.tag}`,
                imagePullPolicy: image.pullPolicy ?? "Always",
                ports: [
                  { name: "http", containerPort: httpPort },
                  ...ports.map(([hostPort, containerPort]) => ({
                    hostPort,
                    containerPort,
                  })),
                ],
                resources: { limits },
                env: Object.entries(env).map(([name, value]) => ({
                  name,
                  value,
                })),
                volumeMounts: [
                  ...hostVolumes.map(({ name, mountPath, readOnly }) => ({
                    name,
                    mountPath,
                    readOnly,
                  })),
                  ...persistence.map(({ name, mountPath, readOnly }) => ({
                    name,
                    mountPath,
                    readOnly,
                  })),
                ],
                ...probes,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  seccompProfile: { type: "RuntimeDefault" },
                  ...(dropCapabilities && { capabilities: { drop: ["ALL"] } }),
                },
              },
            ],
            securityContext,
            volumes: [
              ...hostVolumes.map(({ name, hostPath, hostPathType }) => ({
                name,
                hostPath: {
                  path: hostPath,
                  type: hostPathType,
                },
              })),
              ...Object.entries(pvcs).map(([name, pvc]) => ({
                name,
                persistentVolumeClaim: { claimName: pvc.metadata.name },
              })),
            ],
          },
        },
      },
    },
    { deleteBeforeReplace: persistence.length > 0, provider },
  );

  // Egress only — see `networkPolicy` in the schema for why ingress is left
  // alone. DNS needs its own rule because the cluster resolver's ClusterIP
  // sits inside the private space the second rule excludes; policy rules are
  // OR'd, so the narrow allow survives the broad deny.
  if (networkPolicy) {
    new k8s.networking.v1.NetworkPolicy(
      `${serviceName}-netpol`,
      {
        metadata: { name: serviceName },
        spec: {
          podSelector: { matchLabels: { app: serviceName } },
          policyTypes: ["Egress"],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      "kubernetes.io/metadata.name": "kube-system",
                    },
                  },
                },
              ],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
            {
              to: [
                {
                  ipBlock: {
                    cidr: "0.0.0.0/0",
                    except: [
                      "10.0.0.0/8", // pod + service CIDRs, and any LAN using it
                      "172.16.0.0/12",
                      "192.168.0.0/16", // the node's own LAN
                      "169.254.0.0/16",
                      "100.64.0.0/10", // tailnet
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      { provider },
    );
  }

  return service;
}
