import * as k8s from "@pulumi/kubernetes";

interface Volume {
  storageClass: string;
  storageSize: string;
  claimStorageSize: string;
  path: string;
  mountPath: string;
  accessModes: string[];
}

export interface LocalStorageServiceArgs {
  env?: Record<string, string>;
  ports?: { http: number };
  persistence: Record<string, Volume>;
  image: {
    repository: string;
    tag: string;
    pullPolicy: string;
  };
  resources: {
    limits: {
      memory: string;
      cpu: string;
    };
  };
  nodeSelector: {
    key: string;
    operator: string;
    values: string[];
  };
}

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
  const volumes: Record<string, k8s.core.v1.PersistentVolume> = {};

  for (const [key, volume] of Object.entries(persistence)) {
    volumes[key] = new k8s.core.v1.PersistentVolume(
      `${name}-${key}-vol`,
      {
        metadata: {
          labels: {
            storageName: `${name}-${key}-vol`,
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
      { provider }
    );
  }
  const service = new k8s.core.v1.Service(
    `${name}-service`,
    {
      metadata: {
        // TODO: Auto generate this in future when we use the output for DNS
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
                imagePullPolicy: image.pullPolicy,
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
                  storageName: `${name}-${key}-vol`,
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
    { provider }
  );

  return service;
}
