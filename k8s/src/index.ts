import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLocalServer } from "./templates";
import type { ServersConf } from "./types";

const config = new pulumi.Config();

export const namespace = new k8s.core.v1.Namespace("main", {
  metadata: {
    name: "jaritanet",
  },
});

for (const server of config.requireObject<ServersConf>("servers")) {
  switch (server.template) {
    case "local-server": {
      createLocalServer(server.name, server.args);
      break;
    }
    case "web-server": {
      break;
    }
  }
}
