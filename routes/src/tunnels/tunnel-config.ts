import * as cloudflare from "@pulumi/cloudflare";
import type * as pulumi from "@pulumi/pulumi";

export function createTunnelConfig(
  accountId: string,
  tunnelId: string,
  tunnelName: string,
  ingressRules: pulumi.Output<
    cloudflare.types.input.ZeroTrustTunnelCloudflaredConfigConfigIngressRule[]
  >
) {
  new cloudflare.ZeroTrustTunnelCloudflaredConfig(
    `${tunnelName}-tunnel-config`,
    {
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
    }
  );
}
