import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLocalServer } from "./templates";
import type { ServersConf } from "./types";

const config = new pulumi.Config();

const provider = new k8s.Provider("provider", {
  renderYamlToDirectory: "rendered/",
});

const namespace = new k8s.core.v1.Namespace(
  "jaritanet",
  {
    metadata: {
      name: "jaritanet",
    },
  },
  { provider }
);

// TODO: Make this generate the infra config
interface ServerOutput extends Record<string, string> {
  service: string;
}

export const servers: Record<string, ServerOutput> = {};

for (const { name, args, template } of config.requireObject<ServersConf>(
  "servers"
)) {
  switch (template) {
    case "local-server": {
      servers[name] = createLocalServer(provider, namespace, name, args);
      break;
    }
    case "web-server": {
      break;
    }
  }
}
