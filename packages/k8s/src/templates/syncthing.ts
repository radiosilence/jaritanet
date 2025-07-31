import * as k8s from "@pulumi/kubernetes";
import type * as z from "zod";
import type { SyncthingArgsSchema } from "./syncthing.schemas.ts";

const annotations = {
  "pulumi.com/skipAwait": "false",
};

/**
 * Creates a Syncthing StatefulSet deployment with persistent volumes for config and data.
 * Uses StatefulSet instead of Deployment to ensure stable network identity and ordered scaling.
 */
export function createSyncthing(
  provider: k8s.Provider,
  name: string,
  {
    env,
    healthCheck,
    hostVolumes,
    httpPort,
    image,
    limits,
    persistence,
    ports,
    securityContext,
  }: z.infer<typeof SyncthingArgsSchema>,
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
          `${name}-${key}-pv`,
          {
            metadata: {
              annotations,
            },
            spec: {
              capacity: {
                storage,
              },
              volumeMode: "Filesystem",
              accessModes: readOnly ? ["ReadOnlyMany"] : ["ReadWriteMany"],
              persistentVolumeReclaimPolicy: "Delete",
              storageClassName,
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
          `${name}-${key}-pvc`,
          {
            metadata: {
              annotations,
            },
            spec: {
              storageClassName,
              volumeName: pvs[key]?.metadata.name,
              accessModes: readOnly ? ["ReadOnlyMany"] : ["ReadWriteMany"],
              resources: { requests: { storage } },
            },
          },
          { provider },
        ),
      ]),
  );

  // Service for web UI and sync ports
  const service = new k8s.core.v1.Service(
    `${name}-service`,
    {
      metadata: {
        name: `${name}-service`,
        annotations,
      },
      spec: {
        selector: { app: name },
        ports: [
          {
            name: "web-ui",
            protocol: "TCP",
            port: 80,
            targetPort: httpPort,
          },
          {
            name: "sync-tcp",
            protocol: "TCP",
            port: 22000,
            targetPort: 22000,
          },
          {
            name: "sync-udp",
            protocol: "UDP",
            port: 22000,
            targetPort: 22000,
          },
          {
            name: "discovery",
            protocol: "UDP",
            port: 21027,
            targetPort: 21027,
          },
          ...ports.map(([port, targetPort], idx) => ({
            name: `custom-${idx}`,
            protocol: "TCP",
            port,
            targetPort,
          })),
        ],
      },
    },
    { provider },
  );

  // StatefulSet for stable network identity
  new k8s.apps.v1.StatefulSet(
    `${name}-statefulset`,
    {
      metadata: {
        annotations,
      },
      spec: {
        replicas: 1, // Syncthing should only have one replica to avoid conflicts
        serviceName: `${name}-service`,
        selector: {
          matchLabels: { app: name },
        },
        template: {
          metadata: {
            labels: { app: name },
            annotations,
          },
          spec: {
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
            containers: [
              {
                name,
                image: `${image.repository}:${image.tag}`,
                imagePullPolicy: "Always",
                ports: [
                  { name: "web-ui", containerPort: httpPort },
                  { name: "sync-tcp", containerPort: 22000, protocol: "TCP" },
                  { name: "sync-udp", containerPort: 22000, protocol: "UDP" },
                  { name: "discovery", containerPort: 21027, protocol: "UDP" },
                  ...ports.map(([hostPort, containerPort]) => ({
                    hostPort,
                    containerPort,
                  })),
                ],
                resources: { limits },
                env: [
                  { name: "PUID", value: "1000" },
                  { name: "PGID", value: "1000" },
                  { name: "TZ", value: "UTC" },
                  ...Object.entries(env).map(([name, value]) => ({
                    name,
                    value,
                  })),
                ],
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
                ...(healthCheck && {
                  ...(healthCheck.enableLiveness && {
                    livenessProbe: {
                      httpGet: {
                        path: healthCheck.path,
                        port: healthCheck.port ?? httpPort,
                        ...(healthCheck.httpHeaders.length > 0 && {
                          httpHeaders: healthCheck.httpHeaders,
                        }),
                      },
                      initialDelaySeconds: healthCheck.initialDelaySeconds,
                      periodSeconds: healthCheck.periodSeconds,
                      timeoutSeconds: healthCheck.timeoutSeconds,
                      failureThreshold: healthCheck.failureThreshold,
                      successThreshold: healthCheck.successThreshold,
                    },
                  }),
                  ...(healthCheck.enableReadiness && {
                    readinessProbe: {
                      httpGet: {
                        path: healthCheck.path,
                        port: healthCheck.port ?? httpPort,
                        ...(healthCheck.httpHeaders.length > 0 && {
                          httpHeaders: healthCheck.httpHeaders,
                        }),
                      },
                      initialDelaySeconds: healthCheck.initialDelaySeconds,
                      periodSeconds: healthCheck.periodSeconds,
                      timeoutSeconds: healthCheck.timeoutSeconds,
                      failureThreshold: healthCheck.failureThreshold,
                      successThreshold: healthCheck.successThreshold,
                    },
                  }),
                  ...(healthCheck.enableStartup && {
                    startupProbe: {
                      httpGet: {
                        path: healthCheck.path,
                        port: healthCheck.port ?? httpPort,
                        ...(healthCheck.httpHeaders.length > 0 && {
                          httpHeaders: healthCheck.httpHeaders,
                        }),
                      },
                      initialDelaySeconds: healthCheck.initialDelaySeconds,
                      periodSeconds: healthCheck.periodSeconds,
                      timeoutSeconds: healthCheck.timeoutSeconds,
                      failureThreshold: Math.max(
                        healthCheck.failureThreshold * 3,
                        30,
                      ),
                      successThreshold: healthCheck.successThreshold,
                    },
                  }),
                }),
                securityContext: {
                  runAsUser: 1000,
                  runAsGroup: 1000,
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                },
              },
            ],
          },
        },
      },
    },
    { provider, deleteBeforeReplace: true },
  );

  return service;
}
