local k = import 'lib/k.libsonnet';

function(name='blit', tag='latest') [
  k.v1.Service(name + '-service') {
    spec: {
      ports: [
        {
          port: 80,
          targetPort: 80,
        },
      ],
      selector: {
        app: name,
      },
    },
  },
  k.apps.v1.Deployment(name) {
    spec: {
      replicas: 2,
      selector: {
        matchLabels: {
          app: name,
        },
      },
      template: {
        metadata: {
          labels: {
            app: name,
          },
        },
        spec: {
          containers: [
            {
              name: name,
              image: 'ghcr.io/radiosilence/blit:' + tag,
              ports: [
                {
                  containerPort: 80,
                },
              ],
              resources: {
                limits: {
                  memory: '64Mi',
                  cpu: '50m',
                },
              },
            },
          ],
        },
      },
    },
  },
]
