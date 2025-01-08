import * as pulumi from "@pulumi/pulumi";
import type { CloudflareConf, ServiceStackConf, ZoneConf } from "./conf";
import * as modules from "./modules";
import {
  createTunnelConfig,
  getServiceIngressRule,
  type ServiceOutput,
} from "./tunnels";

const config = new pulumi.Config();

const zones = config.requireObject<ZoneConf[]>("zones");

for (const zone of zones) {
  for (const module of zone.modules) {
    modules[module](zone);
  }
}

const serviceStacks = config.requireObject<ServiceStackConf[]>("serviceStacks");

for (const { path, stack = pulumi.getStack() } of serviceStacks) {
  console.log(`Deploying service stack ${path}/${stack}`);
  const stackRef = new pulumi.StackReference(`${path}/${stack}`);
  const servicesOutput = stackRef.requireOutput("services");

  const { accountId } = config.requireObject<CloudflareConf>("cloudflare");
  const tunnelId = "TODO";
  const tunnelName = "TODO";

  const ingressRules = servicesOutput.apply((services: ServiceOutput[]) => {
    return [
      ...services.map(({ hostname, service }: ServiceOutput) =>
        getServiceIngressRule(hostname, service)
      ),
      // TODO: Deprecate this in favor of the above.
      ...zones.flatMap((zone) =>
        (zone.services ?? []).map(({ hostname, service }) =>
          getServiceIngressRule(hostname, service)
        )
      ),
    ];
  });

  createTunnelConfig(accountId, tunnelId, tunnelName, ingressRules);
}
