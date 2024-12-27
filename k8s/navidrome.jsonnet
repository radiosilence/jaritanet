local localServer = import './lib/local-server.libsonnet';

function(name='navidrome') localServer({
  persistence: {
    music: {
      storageClass: 'local-storage',
      storageSize: '1Ti',
      path: '/mnt/kontent/music',
      mountPath: '/music',
      accessMode: 'ReadOnlyMany',
    },
    data: {
      storageClass: 'local-storage',
      storageSize: '1Gi',
      path: '/home/navidrome/data',
      mountPath: '/data',
      accessMode: 'ReadWriteOnce',
    },
  },
  statefulset: {
    name: name,
    replicas: 1,
    image: {
      repository: 'deluan/navidrome',
      tag: 'latest',
      pullPolicy: 'Always',
    },
    ports: {
      web: 4533,
    },
    resources: {
      limits: {
        memory: '4Gi',
        cpu: '4',
      },
    },
    nodeSelector: {
      key: 'kubernetes.io/hostname',
      operator: 'In',
      values: [
        'oldboy',
      ],
    },
    environment: {
      ND_SCANSCHEDULE: '1h',
      ND_LOGLEVEL: 'info',
      ND_SESSIONTIMEOUT: '24h',
      ND_ENABLESHARING: 'true',
      ND_ENABLETRANSCODINGCONFIG: 'true',
    },
  },
  service: {
    name: name + '-service',
    port: 80,
  },
})
