import * as k8s from "@pulumi/kubernetes";
import type { z } from "zod";
import type { ServiceArgsSchema } from "./service.schemas";

export function createService(
  provider: k8s.Provider,
  name: string,
  {
    image,
    replicas,
    httpPort,
    limits,
    hostVolumes,
    persistence,
    env,
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
            spec: {
              capacity: {
                storage,
              },
              volumeMode: "Filesystem",
              accessModes: readOnly ? ["ReadOnlyMany"] : ["ReadWriteOnce"],
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
    persistence.map(({ name: key, storageClassName, readOnly, storage }) => [
      key,
      new k8s.core.v1.PersistentVolumeClaim(
        `${name}-${key}-pvc`,
        {
          spec: {
            storageClassName,
            volumeName: pvs[key].metadata.name,
            accessModes: readOnly ? ["ReadOnlyMany"] : ["ReadWriteOnce"],
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
      spec: {
        replicas,
        selector: {
          matchLabels: { app: name },
        },
        strategy: {
          type: "Recreate",
        },
        template: {
          metadata: {
            labels: { app: name },
          },
          spec: {
            volumes: [
              ...hostVolumes.map(({ name, hostPath, hostPathType }) => ({
                name,
                hostPath: {
                  path: hostPath,
                  type: hostPathType,
                },
              })),
              ...Object.keys(pvcs).map((name) => ({
                name,
                persistentVolumeClaim: { claimName: pvcs[name].metadata.name },
              })),
            ],
            containers: [
              {
                name,
                image: `${image.repository}:${image.tag}`,
                imagePullPolicy: "Always",
                ports: [{ name: "http", containerPort: httpPort }],
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
