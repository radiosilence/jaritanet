import * as pulumi from "@pulumi/pulumi";
import { createTunnel } from "./modules";
import type { TunnelConf } from "./types";

const config = new pulumi.Config();

const { name } = config.requireObject<TunnelConf>("tunnel");

export const tunnel = createTunnel(name);
