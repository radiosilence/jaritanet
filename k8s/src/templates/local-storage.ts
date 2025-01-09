import * as k8s from "@pulumi/kubernetes";
import type { LocalStorageServiceArgs } from "./local-storage.schemas";

export function createLocalStorageService(
  provider: k8s.Provider,
  name: string,
  {
    ports = { http: 80 },
    persistence,
    resources,
    env = {},
    image,
  }: LocalStorageServiceArgs
) {
  const service = new k8s.core.v1.Service(
    `${name}-service`,
    {
      metadata: {
        name: `${name}-service`,
      },
      spec: {
        selector: { app: name },
        ports: [{ protocol: "TCP", port: 80, targetPort: ports.http }],
      },
    },
    { provider, deleteBeforeReplace: true }
  );

  for (const [key, volume] of Object.entries(persistence)) {
    new k8s.storage.v1.StorageClass(
      `${key}-storage-class`,
      {
        metadata: {
          name: `${key}-storage-class`,
        },
        provisioner: "microk8s.io/hostpath",
        reclaimPolicy: "Retain",
        parameters: {
          pvDir: volume.path,
        },
        volumeBindingMode: "WaitForFirstConsumer",
      },
      { provider }
    );
  }

  new k8s.apps.v1.StatefulSet(
    `${name}-statefulset`,
    {
      spec: {
        serviceName: service.metadata.name,
        replicas: 1,
        selector: {
          matchLabels: { app: name },
        },
        template: {
          metadata: {
            labels: { app: name },
          },
          spec: {
            containers: [
              {
                name,
                image: `${image.repository}:${image.tag}`,
                imagePullPolicy: image.pullPolicy ?? "Always",
                ports: Object.entries(ports).map(([name, containerPort]) => ({
                  name,
                  containerPort,
                })),
                env: Object.entries(env).map(([key, value]) => ({
                  name: key,
                  value,
                })),
                resources: {
                  limits: {
                    memory: resources.limits.memory,
                    cpu: resources.limits.cpu,
                  },
                },
                volumeMounts: Object.entries(persistence).map(
                  ([key, volume]) => ({
                    name: `${key}-pvc`,
                    mountPath: volume.mountPath,
                  })
                ),
              },
            ],
          },
        },
        volumeClaimTemplates: Object.entries(persistence).map(
          ([key, volume]) => ({
            metadata: {
              name: `${key}-pvc`,
            },
            spec: {
              accessModes: volume.accessModes,
              storageClassName: `${key}-storage-class`,
              resources: {
                requests: {
                  storage: volume.storageSize,
                },
              },
            },
          })
        ),
      },
    },
    { provider, deleteBeforeReplace: true }
  );

  return service;
}
