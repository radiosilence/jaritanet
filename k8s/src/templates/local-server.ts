import * as k8s from "@pulumi/kubernetes";

export const service = [];

interface Volume {
  storageClass: string;
  storageSize: string;
  claimStorageSize: string;
  path: string;
  mountPath: string;
  accessMode: string;
  volumeMode: string;
}

export interface LocalServerArgs {
  environment?: Record<string, string>;
  ports: Record<string, number> & { web: number };
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

export function createLocalServer(
  provider: k8s.Provider,
  name: string,
  {
    ports,
    persistence,
    resources,
    environment = {},
    image,
    nodeSelector,
  }: LocalServerArgs
) {
  const serviceName = `${name}-service`;
  const statefulSet = new k8s.apps.v1.StatefulSet(
    `${name}-statefulset`,
    {
      spec: {
        serviceName,
        replicas: 1,
        selector: {
          matchLabels: { name },
        },
        template: {
          metadata: {
            labels: { name },
          },
          spec: {
            containers: [
              {
                name,
                image: `${image.repository}:${image.tag}`,
                imagePullPolicy: image.pullPolicy,
                ports: Object.entries(ports).map(([name, port]) => ({
                  name,
                  containerPort: port,
                })),
                env: Object.entries(environment).map(([key, value]) => ({
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
              accessModes: [volume.accessMode],
              storageClassName: volume.storageClass,
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
  const service = new k8s.core.v1.Service(
    serviceName,
    {
      spec: {
        selector: { name },
        ports: [{ protocol: "TCP", port: 80, targetPort: ports.web }],
      },
    },
    { provider }
  );

  for (const [key, volume] of Object.entries(persistence)) {
    new k8s.core.v1.PersistentVolume(
      `${name}-${key}-vol`,
      {
        spec: {
          capacity: {
            storage: volume.storageSize,
          },
          volumeMode: volume.volumeMode,
          accessModes: [volume.accessMode],
          storageClassName: volume.storageClass,
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

  return {
    statefulSet,
    service,
  };
}
