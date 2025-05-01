import * as pulumi from "@pulumi/pulumi";
import { RoutesConfSchema } from "./conf.schemas.ts";

const config = new pulumi.Config();

export const conf = RoutesConfSchema.parse({
  serviceStacks: config.requireObject("serviceStacks"),
  zones: config.requireObject("zones"),
  cloudflare: config.requireObject("cloudflare"),
  bluesky: config.requireObject("bluesky"),
  fastmail: config.requireObject("fastmail"),
});
