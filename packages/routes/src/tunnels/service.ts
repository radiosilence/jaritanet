import * as cloudflare from "@pulumi/cloudflare";
import type * as z from "zod";
import type { ServiceSchema, ZoneConfSchema } from "../conf.schemas.ts";

export function getRecord(hostname: string) {
  const parts = hostname.split(".");

  return {
    zoneName: parts.slice(-2).join("."),
    recordName: parts.length === 2 ? "@" : parts.slice(0, -2).join("."),
  };
}

export function getServiceIngress(
  hostname: string,
  service: string,
): cloudflare.types.input.ZeroTrustTunnelCloudflaredConfigConfigIngress {
  return {
    hostname,
    service,
    originRequest: {
      connectTimeout: 120,
    },
  };
}

export function createZone(
  content: string,
  { zoneId }: z.infer<typeof ZoneConfSchema>,
  { hostname, proxied }: z.infer<typeof ServiceSchema>,
) {
  const { recordName: name } = getRecord(hostname);

  return new cloudflare.DnsRecord(`${hostname}-tunneled-record`, {
    zoneId,
    name,
    type: "CNAME",
    content,
    proxied,
    ttl: 1,
  });
}
