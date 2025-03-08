import * as pulumi from "@pulumi/pulumi";
import { parse } from "@schema-hub/zod-error-formatter";
import { RoutesConfSchema } from "./conf.schemas";

const config = new pulumi.Config();

export const conf = parse(RoutesConfSchema, {
  serviceStacks: config.requireObject("serviceStacks"),
  zones: config.requireObject("zones"),
  cloudflare: config.requireObject("cloudflare"),
  bluesky: config.requireObject("bluesky"),
  fastmail: config.requireObject("fastmail"),
});
