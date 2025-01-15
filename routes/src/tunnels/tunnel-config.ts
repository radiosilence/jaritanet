import * as cloudflare from "@pulumi/cloudflare";

export function createTunnelConfig(
  accountId: string,
  tunnelId: string,
  ingressRules: cloudflare.types.input.ZeroTrustTunnelCloudflaredConfigConfigIngressRule[]
) {
  new cloudflare.ZeroTrustTunnelCloudflaredConfig("tunnel-config", {
    accountId,
    tunnelId,
    config: {
      ingressRules: [
        ...ingressRules,
        {
          service: "http_status:404",
        },
      ],
    },
  });
}
