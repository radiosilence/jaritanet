import * as pulumi from "@pulumi/pulumi";
import * as z from "zod";
import { ConfSchema } from "./conf.schemas.ts";
import { resolveEnvRefs } from "./env.ts";

const config = new pulumi.Config();

const { data, error } = ConfSchema.safeParse(
  resolveEnvRefs({
    bluesky: config.requireObject("bluesky"),
    cloudflare: config.requireObject("cloudflare"),
    edges: config.getObject("edges"),
    exits: config.getObject("exits"),
    externalIp: config.get("externalIp"),
    fastmail: config.requireObject("fastmail"),
    gateway: config.getObject("gateway"),
    home: config.getObject("home"),
    mcpGateway: config.getObject("mcpGateway"),
    profiles: config.getObject("profiles"),
    services: config.requireObject("services"),
    traefik: config.requireObject("traefik"),
    zones: config.requireObject("zones"),
  }),
);

if (error) {
  throw new Error(`Could not parse config:\n\n${z.prettifyError(error)}\n\n`);
}

export const conf = data;
