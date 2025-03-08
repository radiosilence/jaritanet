import * as pulumi from "@pulumi/pulumi";
import { parse } from "@schema-hub/zod-error-formatter";
import { K8sConfSchema } from "./conf.schemas";

const config = new pulumi.Config();

export const conf = parse(K8sConfSchema, {
  cloudflared: config.requireObject("cloudflared"),
  services: config.requireObject("services"),
});
