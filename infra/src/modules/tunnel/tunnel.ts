import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type { CloudflareConf, ZoneConf } from "../../types";
import * as dns from "../dns";

const config = new pulumi.Config();
const { accountId } = config.requireObject<CloudflareConf>("cloudflare");

// TODO: Split this into tunnel and dns projects, so we can do [infra] -> tunnel -> k8s -> dns
const stackRef = new pulumi.StackReference(
  `radiosilence/jaritanet-k8s/${pulumi.getStack()}`
);

// TODO: Shared types etc
const servicesOutput = stackRef.requireOutput("services");

/**
 * Creates a new Cloudflare tunnel.
 *
 * @param name - The name of the tunnel.
 * @param zones - The zones to create the tunnel for.
 * @returns The created tunnel.
 */
export function tunnel(name: string, zones: ZoneConf[]) {
  const secret = new random.RandomBytes(`${name}-secret`, {
    length: 256,
  });

  const tunnel = new cloudflare.ZeroTrustTunnelCloudflared(`${name}-tunnel`, {
    accountId,
    name,
    secret: secret.hex,
  });

  const ingressRules = zones.flatMap((zone) => {
    if (!zone.services) return [];

    return zone.services.map(({ name, service }) => ({
      hostname: name === "@" ? zone.name : `${name}.${zone.name}`,
      service:
        typeof service === "string"
          ? service
          : servicesOutput.apply(
              (services: Record<string, { url: string }>) =>
                services[service.ref].url
            ),
      originRequest: {
        connectTimeout: "2m0s",
      },
    }));
  });

  new cloudflare.ZeroTrustTunnelCloudflaredConfig(`${name}-tunnel-config`, {
    accountId,
    tunnelId: tunnel.id,
    config: {
      ingressRules: [
        ...ingressRules,
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
