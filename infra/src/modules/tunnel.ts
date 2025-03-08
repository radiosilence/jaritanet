import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { parse } from "@schema-hub/zod-error-formatter";
import { CloudflareConfSchema } from "../conf.schemas";

const config = new pulumi.Config();
const { accountId } = parse(
  CloudflareConfSchema,
  config.requireObject("cloudflare"),
);

/**
 * Creates a new Cloudflare tunnel
 */
export function createTunnel({
  name,
}: {
  /**
   * The name of the tunnel.
   */
  name: string;
}) {
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
