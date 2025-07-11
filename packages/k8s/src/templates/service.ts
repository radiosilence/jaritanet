import * as k8s from "@pulumi/kubernetes";
import type { z } from "zod/v4";
import type { ServiceArgsSchema } from "./service.schemas.ts";

const annotations = {
  "pulumi.com/skipAwait": "false",
};

export function createService(
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
            protocol: "TCP",
            port: 80,
            targetPort: httpPort,
          },
        ],
      },
    },
    { provider },
  );

  new k8s.apps.v1.Deployment(
    `${name}-deployment`,
    {
      metadata: {
        annotations,
      },
      spec: {
        replicas,
        selector: {
          matchLabels: { app: name },
        },
        strategy,
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
                      ), // Higher threshold for startup
                      successThreshold: healthCheck.successThreshold,
                    },
                  }),
                }),
                securityContext: {
                  allowPrivilegeEscalation: false,
                },
              },
            ],
          },
        },
      },
    },
    { provider, deleteBeforeReplace: persistence.length > 0 },
  );

  return service;
}
