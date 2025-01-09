import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { CloudflareConfSchema } from "../conf.schemas";

const config = new pulumi.Config();
const { accountId } = CloudflareConfSchema.parse(
  config.requireObject("cloudflare")
);

/**
 * Creates a new Cloudflare tunnel.
 *
 * @param name - The name of the tunnel.
 * @returns The created tunnel.
 */
export function createTunnel(name: string) {
  const secret = new random.RandomBytes(`${name}-secret`, {
    length: 256,
  });

  const tunnel = new cloudflare.ZeroTrustTunnelCloudflared(`${name}-tunnel`, {
    accountId,
    name,
    secret: secret.hex,
  });

  return tunnel;
}
