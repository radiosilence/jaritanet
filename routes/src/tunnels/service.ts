import type { ZoneConf } from "src/conf";
import * as cloudflare from "@pulumi/cloudflare";
import type * as pulumi from "@pulumi/pulumi";

export interface ServiceOutput {
  service: string;
  hostname: string;
}

export function getRecord(hostname: string) {
  const parts = hostname.split(".");
  const zoneName = parts.slice(-2).join(".");
  let recordName = parts.slice(0, -2).join(".");

  if (parts.length === 2) {
    recordName = "@";
  }

  return {
    zoneName,
    recordName,
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
  { hostname }: ServiceOutput
) {
  const { recordName: name } = getRecord(hostname);

  return new cloudflare.Record(`${hostname}-tunnel-rule`, {
    zoneId,
    name,
    type: "CNAME",
    content: tunnelCname,
    proxied: true,
  });
}

// export class Service {
//   constructor(servicesOutput: pulumi.Output<ServiceOutput>) {
//     const stackRef = new pulumi.StackReference(
//       `radiosilence/jaritanet-k8s/${pulumi.getStack()}`
//     );
//     const servicesOutput = stackRef.requireOutput("services");
//   }
//   get hostname() {
//     return "TODO";
//   }
//   get service() {
//     return "TODO";
//   }
//   get originRequest() {
//     return {
//       connectTimeout: "2m0s",
//     };
//   }
// }
