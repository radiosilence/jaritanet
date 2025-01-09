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
            volumes: Object.entries(persistence).map(([key, volume]) => ({
              name: `${key}-volume`,
              hostPath: {
                path: volume.hostPath,
                type: "Directory",
              },
            })),
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
                resources,
                volumeMounts: Object.entries(persistence).map(
                  ([key, volume]) => ({
                    name: `${key}-volume`,
                    mountPath: volume.mountPath,
                    readOnly: !volume.rw,
                  })
                ),
              },
            ],
          },
        },
      },
    },
    { provider, deleteBeforeReplace: true }
  );

  return service;
}
