local k = import 'lib/k.libsonnet';

function(token, replicas=2) [
  k.apps.v1.Deployment('cloudflared-deployment') {
    metadata+: {
      labels: {
        app: 'cloudflared',
      },
    },
    spec: {
      replicas: replicas,
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
                token,
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
              resources: {
                limits: {
                  memory: '128Mi',
                  cpu: '250m',
                },
              },
            },
          ],
        },
      },
    },
  },
]
