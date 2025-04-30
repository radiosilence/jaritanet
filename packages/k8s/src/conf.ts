import * as pulumi from "@pulumi/pulumi";
import { K8sConfSchema } from "./conf.schemas";

const config = new pulumi.Config();

export const conf = K8sConfSchema.parse({
  cloudflared: config.requireObject("cloudflared"),
  services: config.requireObject("services"),
});
