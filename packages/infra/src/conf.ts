import * as pulumi from "@pulumi/pulumi";
import * as z from "zod";
import { InfraConfSchema } from "./conf.schemas.ts";

const config = new pulumi.Config();

const { data, error } = InfraConfSchema.safeParse({
  cloudflare: config.requireObject("cloudflare"),
  tunnel: config.requireObject("tunnel"),
});

if (error) {
  throw new Error(`Could not parse config:\n\n${z.prettifyError(error)}\n\n`);
}

export const conf = data;
