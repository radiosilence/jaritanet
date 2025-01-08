import * as pulumi from "@pulumi/pulumi";
import { TunnelConfSchema } from "./conf.schemas";
import { createTunnel } from "./modules";

const config = new pulumi.Config();

const { name } = TunnelConfSchema.parse(config.requireObject("tunnel"));

export const tunnel = createTunnel(name);
