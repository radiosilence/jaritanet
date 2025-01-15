import * as cloudflare from "@pulumi/cloudflare";
import type { Service, ZoneConf } from "../conf.schemas";

export function getRecord(hostname: string) {
  const parts = hostname.split(".");

  return {
    zoneName: parts.slice(-2).join("."),
    recordName: parts.length === 2 ? "@" : parts.slice(0, -2).join("."),
  };
}

export function getServiceIngressRule(
  hostname: string,
  service: string
): cloudflare.types.input.ZeroTrustTunnelCloudflaredConfigConfigIngressRule {
  return {
    hostname,
    service,
    originRequest: {
      connectTimeout: "2m0s",
    },
  };
}

export function createZone(
  tunnelCname: string,
  { zoneId }: ZoneConf,
  { hostname, proxied }: Service
) {
  const { recordName: name } = getRecord(hostname);

  return new cloudflare.Record(`${hostname}-tunneled-record`, {
    zoneId,
    name,
    type: "CNAME",
    content: tunnelCname,
    proxied,
  });
}
