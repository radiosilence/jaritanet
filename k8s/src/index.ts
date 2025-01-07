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
// interface ServiceOutput {
//   url: pulumi.Output<string>;
// }

const templates = {
  "local-server": createLocalServer,
} as const;

export const services = Object.fromEntries(
  config
    .requireObject<ServersConf>("servers")
    .map(({ name, args, template }) => [
      name,
      {
        url: pulumi.interpolate`http://${
          templates[template](provider, name, args).name
        }.${namespace}.svc.cluster.local`,
      },
    ])
);
