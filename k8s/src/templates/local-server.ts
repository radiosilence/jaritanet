import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

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
  namespace: k8s.core.v1.Namespace,
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
  const volumes: Record<string, k8s.core.v1.PersistentVolume> = {};

  for (const [key, volume] of Object.entries(persistence)) {
    volumes[key] = new k8s.core.v1.PersistentVolume(
      `${name}-${key}-vol`,
      {
        metadata: {
          namespace: namespace.metadata.name,
        },
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
  const service = new k8s.core.v1.Service(
    `${name}-service`,
    {
      metadata: {
        namespace: namespace.metadata.name,
      },
      spec: {
        selector: { app: name },
        ports: [{ protocol: "TCP", port: 80, targetPort: ports.web }],
      },
    },
    { provider }
  );

  new k8s.apps.v1.StatefulSet(
    `${name}-statefulset`,
    {
      metadata: {
        namespace: namespace.metadata.name,
      },
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
                  storageName: volumes[key].metadata.name,
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

  return {
    service: pulumi.interpolate`http://${service.metadata.name}.${namespace.metadata.name}.svc.cluster.local`,
  };
}
