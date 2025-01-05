import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import * as dns from "../dns";
import { type ZoneConf } from "../../types";

interface ServiceConf {
  /**
   * The zone to create the record in
   */
  zone: ZoneConf;
  /**
   * The name of the record to create
   */
  name: string;
  /**
   * The hostname to route with
   */
  hostname: string;
  /**
   * The internal service to route to
   */
  service: string;
}

interface TunnelArgs {
  services: ServiceConf[];
  name: string;
}

const config = new pulumi.Config();
const accountId = config.get("cloudflareAccountId");

export function cloudflareTunnel({ services, name }: TunnelArgs) {
  const secret = new random.RandomString(`${name}-secret`, {
    length: 256,
  });

  if (!accountId) throw new Error("Missing Cloudflare account ID");

  const tunnel = new cloudflare.Tunnel(`${name}-tunnel`, {
    accountId,
    name,
    secret: secret.result,
  });

  new cloudflare.TunnelConfig(`${name}-tunnel-config`, {
    accountId,
    tunnelId: tunnel.id,
    config: {
      ingressRules: [
        ...services.map((service) => ({
          ...service,
          originRequest: {
            connectTimeout: "2m0s",
          },
        })),
        {
          service: "http_status:404",
        },
      ],
    },
  });

  for (const { zone, name } of services) {
    dns.record(zone, {
      name,
      type: "CNAME",
      content: tunnel.cname,
      proxied: true,
    });
  }

  return tunnel;
}
