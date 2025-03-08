import * as pulumi from "@pulumi/pulumi";
import { parse } from "@schema-hub/zod-error-formatter";

import { TunnelConfSchema } from "./conf.schemas";
import { createTunnel } from "./modules/tunnel";

const config = new pulumi.Config();

export const tunnel = createTunnel(
  parse(TunnelConfSchema, config.requireObject("tunnel")),
);
