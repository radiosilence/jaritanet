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

  return service;
}
