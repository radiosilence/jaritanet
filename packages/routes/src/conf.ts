import * as pulumi from "@pulumi/pulumi";
import { z } from "zod/v4";
import { RoutesConfSchema } from "./conf.schemas.ts";

const config = new pulumi.Config();

const { data, error } = RoutesConfSchema.safeParse({
  serviceStacks: config.requireObject("serviceStacks"),
  zones: config.requireObject("zones"),
  cloudflare: config.requireObject("cloudflare"),
  bluesky: config.requireObject("bluesky"),
  fastmail: config.requireObject("fastmail"),
});

if (error) {
  throw new Error(`Could not parse config:\n\n${z.prettifyError(error)}\n\n`);
}

export const conf = data;
