import * as k8s from "@pulumi/kubernetes";
import type { LocalStorageServiceArgs } from "./local-storage.schemas";

export function createLocalStorageService(
  provider: k8s.Provider,
  name: string,
  { ports, hostVolumes, limits, env = {}, image }: LocalStorageServiceArgs
) {
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
            targetPort: ports.http,
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
        replicas: 1,
        selector: {
          matchLabels: { app: name },
        },
        template: {
          metadata: {
            labels: { app: name },
          },
          spec: {
            volumes: hostVolumes.map(({ name, hostPath, hostPathType }) => ({
              name,
              hostPath: {
                path: hostPath,
                type: hostPathType,
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
                resources: { limits },
                volumeMounts: hostVolumes.map(
                  ({ name, mountPath, readOnly }) => ({
                    name,
                    mountPath,
                    readOnly,
                  })
                ),
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
