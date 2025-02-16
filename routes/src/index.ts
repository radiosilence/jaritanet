import * as pulumi from "@pulumi/pulumi";
import { parse } from "@schema-hub/zod-error-formatter";
import { z } from "zod";
import {
  type CloudflareConf,
  ServiceSchema,
  ServiceStackConfSchema,
  ZoneConfSchema,
} from "./conf.schemas";
import { bluesky } from "./modules/bluesky";
import { fastmail } from "./modules/fastmail";
import {
  TunnelSchema,
  outputDetails,
  outputDetailsSecret,
} from "./references.schemas";
import {
  createZone,
  getRecord,
  getServiceIngressRule,
} from "./tunnels/service";
import { createTunnelConfig } from "./tunnels/tunnel-config";

const modules = {
  bluesky,
  fastmail,
};

const config = new pulumi.Config();
const serviceStacks = parse(
  z.array(ServiceStackConfSchema),
  config.requireObject("serviceStacks"),
);

const zones = parse(z.array(ZoneConfSchema), config.requireObject("zones"));
const infraStackRef = new pulumi.StackReference(
  `radiosilence/jaritanet/${pulumi.getStack()}`,
);

export = async () => {
  for (const zone of zones) {
    for (const module of zone.modules) {
      modules[module](zone);
    }
  }

  const { secretValue: tunnel } = parse(
    outputDetailsSecret(TunnelSchema),
    await infraStackRef.getOutputDetails("tunnel"),
  );

  for (const { path, stack = pulumi.getStack() } of serviceStacks) {
    const stackRef = new pulumi.StackReference(`${path}/${stack}`);
    const { value: services } = parse(
      outputDetails(z.array(ServiceSchema)),
      await stackRef.getOutputDetails("services"),
    );

    const { accountId } = config.requireObject<CloudflareConf>("cloudflare");

    const ingressRules = services.map(({ hostname, service }) =>
      getServiceIngressRule(hostname, service),
    );

    for (const service of services) {
      const { zoneName } = getRecord(service.hostname);
      const zone = zones.find(z => z.name === zoneName);

      if (!zone) {
        throw new Error(`Zone ${zoneName} not found`);
      }

      createZone(tunnel.cname, zone, service);
    }
    createTunnelConfig(accountId, tunnel.id, ingressRules);
  }
};
