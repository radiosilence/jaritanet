import * as pulumi from "@pulumi/pulumi";
import { InfraConfSchema } from "./conf.schemas.mts";

const config = new pulumi.Config();

export const conf = InfraConfSchema.parse({
  cloudflare: config.requireObject("cloudflare"),
  tunnel: config.requireObject("tunnel"),
});
