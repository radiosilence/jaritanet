import * as pulumi from "@pulumi/pulumi";
import { K8sConfSchema } from "./conf.schemas.ts";

const config = new pulumi.Config();

export const conf = K8sConfSchema.parse({
  cloudflare: config.requireObject("cloudflare"),
  cloudflared: config.requireObject("cloudflared"),
  services: config.requireObject("services"),
});
