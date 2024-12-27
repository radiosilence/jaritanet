local localServer = import './lib/local-server.libsonnet';

localServer({
  name: 'files2',
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
    name: $.name,
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
        memory: '4Gi',
        cpu: '2',
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
    name: $.name + '-service',
    port: 80,
  },
})
