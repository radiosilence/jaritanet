import * as pulumi from "@pulumi/pulumi";
import { z } from "zod/v4";
import { K8sConfSchema } from "./conf.schemas.ts";

const config = new pulumi.Config();

const { data, error } = K8sConfSchema.safeParse({
  cloudflare: config.requireObject("cloudflare"),
  cloudflared: config.requireObject("cloudflared"),
  services: config.requireObject("services"),
});

if (error) {
  throw new Error(`Could not parse config:\n\n${z.prettifyError(error)}\n\n`);
}

export const conf = data;
