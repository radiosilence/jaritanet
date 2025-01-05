local k = import 'lib/k.libsonnet';

function(name='bambi-art', tag='latest') [
  k.v1.Service(name + '-service') {
    spec: {
      ports: [
        {
          port: 80,
          targetPort: 3000,
        },
      ],
      selector: {
        app: name,
      },
    },
  },
  k.apps.v1.Deployment(name) {
    spec: {
      replicas: 1,
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
              image: 'ghcr.io/radiosilence/bambi-art:' + tag,
              ports: [
                {
                  containerPort: 3000,
                },
              ],
            },
          ],
        },
      },
    },
  },
]
