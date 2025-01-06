import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLocalServer } from "./templates";
import type { ServersConf } from "./types";

const config = new pulumi.Config();

export const namespace = "jaritanet";

const provider = new k8s.Provider("provider", {
  // renderYamlToDirectory: "rendered/",
  namespace,
});

new k8s.core.v1.Namespace(
  namespace,
  {
    metadata: {
      name: namespace,
    },
  },
  { provider }
);

// TODO: Make this generate the infra config
interface ServerOutput {
  url: pulumi.Output<string>;
}

export const servers: Record<string, ServerOutput> = {};

for (const { name, args, template } of config.requireObject<ServersConf>(
  "servers"
)) {
  switch (template) {
    case "local-server": {
      const service = createLocalServer(provider, name, args);

      servers[name] = {
        url: pulumi.interpolate`https://${service.service}.${namespace}.svc.cluster.local`,
      };
      break;
    }
    case "web-server": {
      break;
    }
  }
}
