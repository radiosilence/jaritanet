import * as cloudflare from "@pulumi/cloudflare";
import type * as pulumi from "@pulumi/pulumi";

export function createTunnelConfig(
  accountId: string,
  tunnelId: pulumi.Output<string>,
  ingressRules: pulumi.Output<
    cloudflare.types.input.ZeroTrustTunnelCloudflaredConfigConfigIngressRule[]
  >
) {
  new cloudflare.ZeroTrustTunnelCloudflaredConfig("jaritanet-tunnel-config", {
    accountId,
    tunnelId,
    config: {
      ingressRules: ingressRules.apply((rules) => [
        ...rules,
        {
          service: "http_status:404",
        },
      ]),
    },
  });
}
