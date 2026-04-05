import * as pulumi from "@pulumi/pulumi";
import { conf } from "./conf.ts";
import { bluesky } from "./modules/bluesky.ts";
import { fastmail } from "./modules/fastmail.ts";
import { servicesRef, tunnelRef } from "./references.ts";
import { createZone, getRecord, getServiceIngress } from "./tunnels/service.ts";
import { createTunnelConfig } from "./tunnels/tunnel-config.ts";

const modules = {
  bluesky,
  fastmail,
};

export default async function () {
  const infraStackRef = new pulumi.StackReference(
    `${conf.infraStackPath}/${pulumi.getStack()}`,
  );

  for (const zone of conf.zones) {
    for (const module of zone.modules) {
      modules[module](zone);
    }
  }

  const tunnel = await tunnelRef(infraStackRef);

  const stacks = await Promise.all(
    conf.serviceStacks.map(async ({ path, stack = pulumi.getStack() }) => {
      const stackRef = new pulumi.StackReference(`${path}/${stack}`);
      return servicesRef(stackRef);
    }),
  );

  for (const services of stacks) {
    const servicesArray = Object.entries(services).map(([name, service]) =>
      Object.assign({ name }, service),
    );

    const ingresses = servicesArray.map(({ hostname, service }) =>
      getServiceIngress(hostname, service),
    );

    for (const service of servicesArray) {
      const { zoneName } = getRecord(service.hostname);
      const zone = conf.zones.find((z) => z.name === zoneName);

      if (!zone) {
        throw new Error(`Zone ${zoneName} not found`);
      }

      createZone(`${tunnel.id}.cfargotunnel.com`, zone, service);
    }
    createTunnelConfig(conf.cloudflare.accountId, tunnel.id, ingresses);
  }
  return { hi: "ho", ...conf, tunnel };
}
