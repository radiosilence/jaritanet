local constructs = import './constructs.libsonnet';

local values = {
  global: {
    namespace: 'files',
  },
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
    name: 'files',
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
    name: 'files-service',
    port: 80,
  },
  ingress: {
    name: 'files-ingress',
    enabled: true,
    hosts: [
      'files.radiosilence.dev',
    ],
    annotations: {
      'nginx.ingress.kubernetes.io/ssl-redirect': 'false',
    },
  },
};

[constructs.persistent_volume(values, key) for key in std.objectFields(values.persistence)] +
[
  constructs.statefulset(values),
  constructs.service(values),
]
