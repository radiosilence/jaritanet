local k = import './k.libsonnet';

function(values) [
  k.v1.Service(values.service.name) {
    spec: {
      selector: {
        app: values.statefulset.name,
      },
      ports: [
        {
          protocol: 'TCP',
          port: values.service.port,
          targetPort: values.statefulset.ports.web,
        },
      ],
    },
  },
  k.apps.v1.StatefulSet(values.statefulset.name) {
    spec: {
      serviceName: values.service.name,
      replicas: values.statefulset.replicas,
      selector: {
        matchLabels: {
          app: values.statefulset.name,
        },
      },
      template: {
        metadata: {
          labels: {
            app: values.statefulset.name,
          },
        },
        spec: {
          containers: [{
            name: values.statefulset.name,
            image: values.statefulset.image.repository + ':' + values.statefulset.image.tag,
            imagePullPolicy: values.statefulset.image.pullPolicy,
            ports: [
              {
                name: key,
                containerPort: values.statefulset.ports[key],
              }
              for key in std.objectFields(values.statefulset.ports)
            ],
            [if std.objectHas(values.statefulset, 'environment') then 'env']: [
              {
                name: key,
                value: std.toString(values.statefulset.environment[key]),
              }
              for key in std.objectFields(values.statefulset.environment)
            ],
            resources: {
              limits: {
                memory: values.statefulset.resources.limits.memory,
                cpu: values.statefulset.resources.limits.cpu,
              },
            },
            volumeMounts: [
              {
                name: key + '-claim',
                mountPath: values.persistence[key].mountPath,
              }
              for key in std.objectFields(values.persistence)
            ],
          }],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: {
            name: key + '-claim',
          },
          spec: {
            accessModes: [values.persistence[key].accessMode],
            storageClassName: values.persistence[key].storageClass,
            selector: {
              matchLabels: {
                storageName: values.name + '-' + key + '-vol',
              },
            },
            resources: {
              requests: {
                storage: values.persistence[key].storageSize,
              },
            },
          },
        }
        for key in std.objectFields(values.persistence)
      ],
    },
  },
] + [
  k.v1.PersistentVolume(values.name + '-' + key + '-vol') {
    spec: {
      capacity: {
        storage: values.persistence[key].storageSize,
      },
      volumeMode: 'Filesystem',
      accessModes: [
        values.persistence[key].accessMode,
      ],
      persistentVolumeReclaimPolicy: 'Delete',
      storageClassName: values.persistence[key].storageClass,
      'local': {
        path: values.persistence[key].path,
      },
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                {
                  key: values.statefulset.nodeSelector.key,
                  operator: values.statefulset.nodeSelector.operator,
                  values: values.statefulset.nodeSelector.values,
                },
              ],
            },
          ],
        },
      },
    },
  }
  for key in std.objectFields(values.persistence)
]
