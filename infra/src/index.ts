import * as pulumi from "@pulumi/pulumi";
import { parse } from "@schema-hub/zod-error-formatter";

import { TunnelConfSchema } from "./conf.schemas";
import { createTunnel } from "./modules";

const config = new pulumi.Config();

const { name } = parse(TunnelConfSchema, config.requireObject("tunnel"));

export const tunnel = createTunnel(name);
