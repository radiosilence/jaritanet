import * as pulumi from "@pulumi/pulumi";
import { z } from "zod/v4";
import { InfraConfSchema } from "./conf.schemas.ts";

const config = new pulumi.Config();

const { data, error } = InfraConfSchema.safeParse({
  // Core infra
  cloudflare: config.requireObject("cloudflare"),
  tunnel: config.requireObject("tunnel"),

  // K8s
  cloudflared: config.requireObject("cloudflared"),
  services: config.requireObject("services"),
  namespace: config.get("namespace"),
  managedBy: config.get("managedBy"),
  clusterDomain: config.get("clusterDomain"),

  // Routes
  zones: config.requireObject("zones"),
  bluesky: config.requireObject("bluesky"),
  fastmail: config.requireObject("fastmail"),
});

if (error) {
  throw new Error(`Could not parse config:\n\n${z.prettifyError(error)}\n\n`);
}

export const conf = data;
