import * as pulumi from "@pulumi/pulumi";
import { parse } from "@schema-hub/zod-error-formatter";
import { InfraConfSchema } from "./conf.schemas";

const config = new pulumi.Config();

export const conf = parse(InfraConfSchema, {
  cloudflare: config.requireObject("cloudflare"),
  tunnel: config.requireObject("tunnel"),
});
