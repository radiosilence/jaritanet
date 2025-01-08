import * as k8s from "@pulumi/kubernetes";
import type { StaticServiceArgs } from "./static.schemas";

export function createStaticService(
  provider: k8s.Provider,
  name: string,
  { image, ports = { http: 80 } }: StaticServiceArgs
) {
  const service = new k8s.core.v1.Service(
    `${name}-service`,
    {
      spec: {
        selector: { app: name },
        ports: [{ protocol: "TCP", port: 80, targetPort: ports.http }],
      },
    },
    { provider }
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
            containers: [
              {
                name,
                image: `${image.repository}:${image.tag}`,
                imagePullPolicy: "Always",
                ports: Object.entries(ports).map(([name, containerPort]) => ({
                  name,
                  containerPort,
                })),
                resources: {
                  limits: {
                    memory: "64Mi",
                    cpu: "50m",
                  },
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
