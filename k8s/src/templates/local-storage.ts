import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
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
    nodeSelector,
  }: LocalStorageServiceArgs
) {
  const id = new random.RandomString(`${name}-id`, {
    length: 6,
    lower: true,
    special: false,
  });

  const volumes = Object.fromEntries(
    Object.entries(persistence).map(([key, volume]) => [
      key,

      new k8s.core.v1.PersistentVolume(
        `${name}-${key}-vol`,
        {
          metadata: {
            labels: {
              storageName: pulumi.interpolate`${name}-${key}-${id.result}-vol`,
            },
          },
          spec: {
            capacity: {
              storage: volume.storageSize,
            },
            volumeMode: "Filesystem",
            accessModes: volume.accessModes,
            storageClassName: "local-storage",
            persistentVolumeReclaimPolicy: "Delete",
            local: {
              path: volume.path,
            },
            nodeAffinity: {
              required: {
                nodeSelectorTerms: [{ matchExpressions: [nodeSelector] }],
              },
            },
          },
        },
        { provider, deleteBeforeReplace: true }
      ),
    ])
  );

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
                    name: `${key}-claim`,
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
              name: `${key}-claim`,
            },
            spec: {
              accessModes: volume.accessModes,
              storageClassName: "local-storage",
              selector: {
                matchLabels: {
                  storageName: volumes[key].metadata.labels.storageName,
                },
              },
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
