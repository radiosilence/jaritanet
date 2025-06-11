import * as k8s from "@pulumi/kubernetes";
import type { z } from "zod/v4";
import type { CloudflaredArgsSchema } from "./cloudflared.schemas.ts";

export function createCloudflared(
  provider: k8s.Provider,
  name: string,
  token: string,
  { replicas, image, resources }: z.infer<typeof CloudflaredArgsSchema>,
) {
  return new k8s.apps.v1.Deployment(
    `${name}-deployment`,
    {
      metadata: {
        labels: {
          app: name,
        },
      },
      spec: {
        replicas,
        selector: {
          matchLabels: {
            pod: name,
          },
        },
        template: {
          metadata: {
            labels: {
              pod: name,
            },
          },
          spec: {
            containers: [
              {
                command: [
                  "cloudflared",
                  "tunnel",
                  "--no-autoupdate",
                  "--metrics",
                  "0.0.0.0:2000",
                  "run",
                ],
                args: ["--token", token],
                image,
                imagePullPolicy: "Always",
                name: "cloudflared",
                livenessProbe: {
                  httpGet: {
                    path: "/ready",
                    port: 2000,
                  },
                  failureThreshold: 1,
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                resources,
              },
            ],
          },
        },
      },
    },
    { provider },
  );
}
