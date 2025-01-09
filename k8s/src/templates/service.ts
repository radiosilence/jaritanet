import * as k8s from "@pulumi/kubernetes";
import type { ServiceArgs } from "./service.schemas";

export function createService(
  provider: k8s.Provider,
  name: string,
  { image, replicas, httpPort, limits, hostVolumes }: ServiceArgs
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
                imagePullPolicy: "Always",
                ports: [{ name: "http", containerPort: httpPort }],
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
