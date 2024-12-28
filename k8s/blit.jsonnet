local k = import 'github.com/jsonnet-libs/k8s-libsonnet/1.30/main.libsonnet';

function(name='blit', tag='latest', replicas=2) [
  k.core.v1.service.new(name + '-service', { app: name }, [{ port: 80, targetPort: 80 }]),
  k.apps.v1.deployment.new(name, replicas, containers=[
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
  ]) {
    spec+: {
      selector: {
        matchLabels: {
          app: name,
        },
      },
    },
  },
]
