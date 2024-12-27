local Metadata(name) = {
  metadata: {
    name: name,
    labels: {
      name: name,
    },
  },
};

local ApiVersion(v) = { apiVersion: v };

{
  v1:: {
    local apiVersion = ApiVersion('v1'),
    ReplicationController(name): apiVersion + Metadata(name) {
      kind: 'ReplicationController',
    },

    Service(name): apiVersion + Metadata(name) {
      kind: 'Service',
    },

    PersistentVolume(name): apiVersion + Metadata(name) + {
      metadata+: {
        labels+: {
          storageName: name,
        },
      },
    } {
      kind: 'PersistentVolume',
    },

  },

  apps:: {
    local apiVersion = ApiVersion('apps/v1'),
    v1:: {
      Deployment(name): apiVersion + Metadata(name) {
        kind: 'Deployment',
      },
      StatefulSet(name): apiVersion + Metadata(name) {
        kind: 'StatefulSet',
      },
    },
  },

  pair_list_ex(tab, kfield, vfield)::
    [{ [kfield]: k, [vfield]: tab[k] } for k in std.objectFields(tab)],

  pair_list(tab)::
    self.pair_list_ex(tab, 'name', 'value'),
}
