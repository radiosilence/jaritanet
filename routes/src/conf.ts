import * as pulumi from "@pulumi/pulumi";
import { parse } from "@schema-hub/zod-error-formatter";
import { RoutesConfSchema } from "./conf.schemas";

const config = new pulumi.Config();

export const conf = parse(RoutesConfSchema, {
  serviceStacks: config.require("serviceStacks"),
  zones: config.require("zones"),
  cloudflare: config.require("cloudflare"),
  bluesky: config.require("bluesky"),
  fastmail: config.require("fastmail"),
});
