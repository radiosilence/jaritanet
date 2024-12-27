{
  v1:: {

    local ApiVersion = { apiVersion: 'v1' },

    local Metadata(name) = {
      metadata: {
        name: name,
        labels: {
          name: name,
        },
      },
    },

    ReplicationController(name): ApiVersion + Metadata(name) {
      kind: 'ReplicationController',
    },

    Service(name): ApiVersion + Metadata(name) {
      kind: 'Service',
    },

    StatefulSet(name): ApiVersion + Metadata(name) {
      kind: 'StatefulSet',
    },

    PersistentVolume(name): ApiVersion + Metadata(name) {
      kind: 'PersistentVolume',
    },

    Deployment(name): ApiVersion + Metadata(name) {
      kind: 'Deployment',
    },
  },

  pair_list_ex(tab, kfield, vfield)::
    [{ [kfield]: k, [vfield]: tab[k] } for k in std.objectFields(tab)],

  pair_list(tab)::
    self.pair_list_ex(tab, 'name', 'value'),
}
