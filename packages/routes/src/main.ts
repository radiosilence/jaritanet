import * as pulumi from "@pulumi/pulumi";
import { conf } from "./conf";
import { bluesky } from "./modules/bluesky";
import { fastmail } from "./modules/fastmail";
import { createZone, getRecord, getServiceIngress } from "./tunnels/service";
import { createTunnelConfig } from "./tunnels/tunnel-config";

import { createReferences } from "./references";

const modules = {
  bluesky,
  fastmail,
};

const infraStackRef = new pulumi.StackReference(
  `radiosilence/jaritanet/${pulumi.getStack()}`,
);

export = async () => {
  for (const zone of conf.zones) {
    for (const module of zone.modules) {
      modules[module](zone);
    }
  }

  const { getTunnel, getServices } = await createReferences();
  const tunnel = await getTunnel(infraStackRef);

  for (const { path, stack = pulumi.getStack() } of conf.serviceStacks) {
    const stackRef = new pulumi.StackReference(`${path}/${stack}`);
    const services = await getServices(stackRef);

    const ingresses = services.map(({ hostname, service }) =>
      getServiceIngress(hostname, service),
    );

    for (const service of services) {
      const { zoneName } = getRecord(service.hostname);
      const zone = conf.zones.find((z) => z.name === zoneName);

      if (!zone) {
        throw new Error(`Zone ${zoneName} not found`);
      }

      createZone(`${tunnel.id}.cfargotunnel.com`, zone, service);
    }
    createTunnelConfig(conf.cloudflare.accountId, tunnel.id, ingresses);
  }
};
