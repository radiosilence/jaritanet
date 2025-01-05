import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import * as dns from "../dns";

import type { CloudflareConf, ZoneConf } from "../../types";

interface TunnelArgs {
  name: string;
  zones: ZoneConf[];
}

const config = new pulumi.Config();
const { accountId } = config.requireObject<CloudflareConf>("cloudflare");

export function tunnel({ zones, name }: TunnelArgs) {
  const secret = new random.RandomBytes(`${name}-secret`, {
    length: 256,
  });

  if (!accountId) throw new Error("Missing Cloudflare account ID");

  const tunnel = new cloudflare.ZeroTrustTunnelCloudflared(`${name}-tunnel`, {
    accountId,
    name,
    secret: secret.hex,
  });

  const services = zones.flatMap((zone) =>
    (zone.services || []).map(({ name, service }) => ({
      hostname: name === "@" ? zone.name : `${name}.${zone.name}`,
      service,
      originRequest: {
        connectTimeout: "2m0s",
      },
    }))
  );

  new cloudflare.ZeroTrustTunnelCloudflaredConfig(`${name}-tunnel-config`, {
    accountId,
    tunnelId: tunnel.id,
    config: {
      ingressRules: [
        ...services,
        {
          service: "http_status:404",
        },
      ],
    },
  });

  for (const zone of zones) {
    if (!zone.services) continue;
    for (const { name } of zone.services) {
      dns.record(zone, {
        name,
        type: "CNAME",
        content: tunnel.cname,
        proxied: true,
      });
    }
  }

  return tunnel;
}
