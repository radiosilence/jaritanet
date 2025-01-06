import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLocalServer, type LocalServerArgs } from "./lib/local-server";

const config = new pulumi.Config();

export const namespace = new k8s.core.v1.Namespace("main", {
  metadata: {
    name: "main",
  },
});

createLocalServer("files", config.requireObject<LocalServerArgs>("files"));
