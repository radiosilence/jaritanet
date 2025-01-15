import { z } from "zod";
import * as pulumi from "@pulumi/pulumi";
import {
  type CloudflareConf,
  ServiceSchema,
  ServiceStackConfSchema,
  ZoneConfSchema,
} from "./conf.schemas";
import * as modules from "./modules";
import {
  outputDetails,
  outputDetailsSecret,
  TunnelSchema,
} from "./references.schemas";
import {
  createTunnelConfig,
  createZone,
  getRecord,
  getServiceIngressRule,
} from "./tunnels";

const config = new pulumi.Config();
const serviceStacks = z
  .array(ServiceStackConfSchema)
  .parse(config.requireObject("serviceStacks"));

const zones = z.array(ZoneConfSchema).parse(config.requireObject("zones"));
const infraStackRef = new pulumi.StackReference(
  `radiosilence/jaritanet/${pulumi.getStack()}`
);

export = async () => {
  for (const zone of zones) {
    for (const module of zone.modules) {
      modules[module](zone);
    }
  }

  const { secretValue: tunnel } = outputDetailsSecret(TunnelSchema).parse(
    await infraStackRef.getOutputDetails("tunnel")
  );

  for (const { path, stack = pulumi.getStack() } of serviceStacks) {
    const stackRef = new pulumi.StackReference(`${path}/${stack}`);
    const { value: services } = outputDetails(z.array(ServiceSchema)).parse(
      await stackRef.getOutputDetails("services")
    );

    const { accountId } = config.requireObject<CloudflareConf>("cloudflare");

    const ingressRules = services.map(({ hostname, service }) =>
      getServiceIngressRule(hostname, service)
    );

    for (const service of services) {
      const { zoneName } = getRecord(service.hostname);
      const zone = zones.find((z) => z.name === zoneName);

      if (!zone) {
        throw new Error(`Zone ${zoneName} not found`);
      }

      createZone(tunnel.cname, zone, service);
    }
    createTunnelConfig(accountId, tunnel.id, ingressRules);
  }
};
