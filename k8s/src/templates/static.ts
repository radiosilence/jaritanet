import * as k8s from "@pulumi/kubernetes";

export interface StaticServiceArgs {
  image: {
    repository: string;
    tag: string;
  };
}

export function createStaticService(
  provider: k8s.Provider,
  name: string,
  { image }: StaticServiceArgs
) {
  const service = new k8s.core.v1.Service(
    `${name}-service`,
    {
      spec: {
        selector: { app: name },
        ports: [{ protocol: "TCP", port: 80, targetPort: 80 }],
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
                ports: [{ name: "http", containerPort: 80 }],
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
