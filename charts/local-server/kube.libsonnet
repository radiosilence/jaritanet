local Metadata(name) = {
  metadata: {
    name: name,
    labels: {
      name: name,
    },
  },
};

{
  v1:: {
    local ApiVersion = { apiVersion: 'v1' },
    ReplicationController(name): ApiVersion + Metadata(name) {
      kind: 'ReplicationController',
    },

    Service(name): ApiVersion + Metadata(name) {
      kind: 'Service',
    },

    PersistentVolume(name): ApiVersion + {
      metadata: {
        name: name,
        labels: {
          storageName: name,
        },
      },
    } {
      kind: 'PersistentVolume',
    },

    Deployment(name): ApiVersion + Metadata(name) {
      kind: 'Deployment',

    },
  },

  apps:: {
    local ApiVersion = { apiVersion: 'apps/v1' },
    v1:: {
      StatefulSet(name): ApiVersion + Metadata(name) {
        kind: 'StatefulSet',
      },
    },
  },

  pair_list_ex(tab, kfield, vfield)::
    [{ [kfield]: k, [vfield]: tab[k] } for k in std.objectFields(tab)],

  pair_list(tab)::
    self.pair_list_ex(tab, 'name', 'value'),
}
