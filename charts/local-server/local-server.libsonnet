local constructs = import './constructs.libsonnet';

{
  localServer(values)::
    local volumes = {
      ['persistentvolume.' + key + '.yml']: constructs.persistent_volume(values, key)
      for key in std.objectFields(values.persistence)
    };

    local rest = {
      'service.yml': constructs.service(values),
      'statefulset.yml': constructs.statefulset(values),
    };
    rest + volumes,
}
