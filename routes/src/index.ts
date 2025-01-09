import { z } from "zod";
import type * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import {
  type CloudflareConf,
  ServiceStackConfSchema,
  ZoneConfSchema,
} from "./conf.schemas";
import {
  createTunnelConfig,
  createZone,
  getRecord,
  getServiceIngressRule,
  type ServiceOutput,
} from "./tunnels";

const config = new pulumi.Config();
const serviceStacks = z
  .array(ServiceStackConfSchema)
  .parse(config.requireObject("serviceStacks"));

const zones = z.array(ZoneConfSchema).parse(config.requireObject("zones"));

for (const zone of zones) {
  for (const module of zone.modules) {
    modules[module](zone);
  }
}
const infraStackRef = new pulumi.StackReference(
  `radiosilence/jaritanet/${pulumi.getStack()}`
);

const tunnelOutput = infraStackRef.requireOutput(
  "tunnel"
) as pulumi.Output<cloudflare.ZeroTrustTunnelCloudflared>;

for (const { path, stack = pulumi.getStack() } of serviceStacks) {
  const stackRef = new pulumi.StackReference(`${path}/${stack}`);
  const servicesOutput = stackRef.requireOutput("services");

  const { accountId } = config.requireObject<CloudflareConf>("cloudflare");

  const ingressRules = servicesOutput.apply((services: ServiceOutput[]) => {
    return services.map(({ hostname, service }: ServiceOutput) =>
      getServiceIngressRule(hostname, service)
    );
  });

  servicesOutput.apply((services: ServiceOutput[]) => {
    for (const service of services) {
      const { zoneName } = getRecord(service.hostname);
      const zone = zones.find((z) => z.name === zoneName);

      if (!zone) {
        throw new Error(`Zone ${zoneName} not found`);
      }

      createZone(
        tunnelOutput.apply((t) => t.cname),
        zone,
        service
      );
    }
  });
  createTunnelConfig(
    accountId,
    tunnelOutput.apply((t) => t.id),
    ingressRules
  );
}
