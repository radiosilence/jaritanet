local localServer = import './lib/local-server.libsonnet';

function(name='files') localServer({
  persistence: {
    files: {
      storageClass: 'local-storage',
      storageSize: '10Gi',
      claimStorageSize: '5Gi',
      path: '/srv/files',
      mountPath: '/srv/files',
      accessMode: 'ReadOnlyMany',
    },
  },
  statefulset: {
    name: name,
    replicas: 1,
    image: {
      repository: 'ghcr.io/radiosilence/jaritanet-files',
      tag: 'latest',
      pullPolicy: 'Always',
    },
    ports: {
      web: 80,
    },
    resources: {
      limits: {
        memory: '128Mi',
        cpu: '50m',
      },
    },
    nodeSelector: {
      key: 'kubernetes.io/hostname',
      operator: 'In',
      values: [
        'oldboy',
      ],
    },
  },
  service: {
    name: name + '-service',
    port: 80,
  },
})
