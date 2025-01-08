import * as pulumi from "@pulumi/pulumi";
import { createTunnel as createTunnel } from "./modules";
import type { TunnelConf } from "./types";

const config = new pulumi.Config();

export const tunnel = createTunnel(
  config.requireObject<TunnelConf>("tunnel").name
);
