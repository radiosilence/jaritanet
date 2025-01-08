import type * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import type { CloudflareConf, ServiceStackConf, ZoneConf } from "./conf";
import * as modules from "./modules";
import {
  createTunnelConfig,
  createZone,
  getRecord,
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

const infraStackRef = new pulumi.StackReference(
  `radiosilence/jaritanet/${pulumi.getStack()}`
);

const tunnelOutput = infraStackRef.requireOutput("tunnel");

for (const { path, stack = pulumi.getStack() } of serviceStacks) {
  console.log(`Deploying service stack ${path}/${stack}`);
  const stackRef = new pulumi.StackReference(`${path}/${stack}`);
  const servicesOutput = stackRef.requireOutput("services");

  const { accountId } = config.requireObject<CloudflareConf>("cloudflare");

  const ingressRules = servicesOutput.apply((services: ServiceOutput[]) => {
    return [
      ...services.map(({ hostname, service }: ServiceOutput) =>
        getServiceIngressRule(hostname, service)
      ),
      // TODO: remove this in favor of the above.
      ...zones.flatMap((zone) =>
        (zone.services ?? []).map(({ hostname, service }) =>
          getServiceIngressRule(hostname, service)
        )
      ),
    ];
  });

  servicesOutput.apply((services: ServiceOutput[]) => {
    for (const service of services) {
      const { zoneName } = getRecord(service.hostname);
      const zone = zones.find((z) => z.name === zoneName);

      if (!zone) {
        throw new Error(`Zone ${zoneName} not found`);
      }

      createZone(
        tunnelOutput.apply(
          (t: cloudflare.ZeroTrustTunnelCloudflared) => t.cname
        ),
        zone,
        service
      );
    }
  });
  createTunnelConfig(
    accountId,
    tunnelOutput.apply((t: cloudflare.ZeroTrustTunnelCloudflared) => t.id),
    ingressRules
  );
}

// TODO: Legacy, support, remove
for (const zone of zones) {
  if (!zone.services) continue;
  for (const service of zone.services) {
    createZone(
      tunnelOutput.apply((t: cloudflare.ZeroTrustTunnelCloudflared) => t.cname),
      zone,
      service
    );
  }
}
