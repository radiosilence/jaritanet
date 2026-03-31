import * as pulumi from "@pulumi/pulumi";
import * as z from "zod";
import { RoutesConfSchema } from "./conf.schemas.ts";

const config = new pulumi.Config();

const { data, error } = RoutesConfSchema.safeParse({
  bluesky: config.requireObject("bluesky"),
  cloudflare: config.requireObject("cloudflare"),
  fastmail: config.requireObject("fastmail"),
  serviceStacks: config.requireObject("serviceStacks"),
  zones: config.requireObject("zones"),
});

if (error) {
  throw new Error(`Could not parse config:\n\n${z.prettifyError(error)}\n\n`);
}

export const conf = data;
