import * as cloudflare from "@pulumi/cloudflare";

export function createTunnelConfig(
  accountId: string,
  tunnelId: string,
  ingresses: cloudflare.types.input.ZeroTrustTunnelCloudflaredConfigConfigIngress[],
) {
  new cloudflare.ZeroTrustTunnelCloudflaredConfig("tunnel-config", {
    accountId,
    tunnelId,
    config: {
      warpRouting: {
        enabled: false,
      },
      ingresses: [
        ...ingresses,
        {
          service: "http_status:404",
        },
      ],
    },
  });
}
