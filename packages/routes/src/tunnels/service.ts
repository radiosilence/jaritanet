import * as cloudflare from "@pulumi/cloudflare";
import type * as z from "zod";
import type { ServiceSchema, ZoneConfSchema } from "../conf.schemas.ts";

export function getRecord(hostname: string) {
  const parts = hostname.split(".");

  return {
    recordName: parts.length === 2 ? "@" : parts.slice(0, -2).join("."),
    zoneName: parts.slice(-2).join("."),
  };
}

export function getServiceIngress(
  hostname: string,
  service: string,
): cloudflare.types.input.ZeroTrustTunnelCloudflaredConfigConfigIngress {
  return {
    hostname,
    originRequest: {
      connectTimeout: 120,
    },
    service,
  };
}

export function createZone(
  content: string,
  { zoneId }: z.infer<typeof ZoneConfSchema>,
  { hostname, proxied }: z.infer<typeof ServiceSchema>,
) {
  const { recordName: name } = getRecord(hostname);

  return new cloudflare.DnsRecord(`${hostname}-tunneled-record`, {
    content,
    name,
    proxied,
    ttl: 1,
    type: "CNAME",
    zoneId,
  });
}
