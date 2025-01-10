import * as k8s from "@pulumi/kubernetes";
import type { ServiceArgs } from "./service.schemas";

export function createService(
  provider: k8s.Provider,
  name: string,
  { image, replicas, httpPort, limits, hostVolumes, persistence }: ServiceArgs
) {
  const pvcs = Object.fromEntries(
    Object.entries(persistence).map(
      ([key, { storageClassName, accessModes, storage }]) => [
        key,
        new k8s.core.v1.PersistentVolumeClaim(
          `${name}-${key}-pvc`,
          {
            spec: {
              storageClassName,
              accessModes,
              resources: { requests: { storage } },
            },
          },
          { provider }
        ),
      ]
    )
  );

  Object.fromEntries(
    Object.entries(persistence).map(
      ([
        key,
        {
          localPath,
          storageClassName,
          storage,
          accessModes,
          nodeAffinityHostname,
        },
      ]) => [
        key,
        new k8s.core.v1.PersistentVolume(
          `${name}-${key}-pv`,
          {
            spec: {
              claimRef: {
                name: pvcs[key].metadata.name,
              },
              capacity: {
                storage,
              },
              volumeMode: "Filesystem",
              accessModes,
              persistentVolumeReclaimPolicy: "Delete",
              storageClassName,
              local: {
                path: localPath,
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
          { provider }
        ),
      ]
    )
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
    { provider, deleteBeforeReplace: true }
  );

  new k8s.apps.v1.Deployment(
    `${name}-deployment`,
    {
      spec: {
        replicas,
        selector: {
          matchLabels: { app: name },
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
              ...Object.keys(pvcs).map((key) => ({
                name: `${name}-${key}-pvc-vol`,
                persistentVolumeClaim: { claimName: pvcs[key].metadata.name },
              })),
            ],
            containers: [
              {
                name,
                image: `${image.repository}:${image.tag}`,
                imagePullPolicy: "Always",
                ports: [{ name: "http", containerPort: httpPort }],
                resources: { limits },
                volumeMounts: [
                  ...hostVolumes.map(({ name, mountPath, readOnly }) => ({
                    name,
                    mountPath,
                    readOnly,
                  })),
                  ...Object.entries(hostVolumes).map(([key, volume]) => ({
                    name: `${name}-${key}-pvc-vol`,
                    mountPath: volume.mountPath,
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
    { provider }
  );

  return service;
}
