local k = import 'lib/k.libsonnet';
local outputs = import 'outputs.json';

[
  k.apps.v1.Deployment('cloudflared-deployment') {
    metadata+: {
      labels: {
        app: 'cloudflared',
      },
    },
    spec: {
      replicas: 2,
      selector: {
        matchLabels: {
          pod: 'cloudflared',
        },
      },
      template: {
        metadata: {
          labels: {
            pod: 'cloudflared',
          },
        },
        spec: {
          containers: [
            {
              command: [
                'cloudflared',
                'tunnel',
                '--no-autoupdate',
                '--metrics',
                '0.0.0.0:2000',
                'run',
              ],
              args: [
                '--token',
                outputs.jaritanet_tunnel_token.value,
              ],
              image: 'cloudflare/cloudflared:latest',
              imagePullPolicy: 'Always',
              name: 'cloudflared',
              livenessProbe: {
                httpGet: {
                  path: '/ready',
                  port: 2000,
                },
                failureThreshold: 1,
                initialDelaySeconds: 10,
                periodSeconds: 10,
              },
            },
          ],
        },
      },
    },
  },
]
