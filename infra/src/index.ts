import * as pulumi from "@pulumi/pulumi";
import { tunnel } from "./modules";
import type { TunnelConf } from "./types";

const config = new pulumi.Config();

const jaritanetTunnel = tunnel(config.requireObject<TunnelConf>("tunnel").name);

export const { tunnelToken, name: tunnelName, id: tunnelId } = jaritanetTunnel;
