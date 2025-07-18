import * as cloudflare from "@pulumi/cloudflare";
import * as random from "@pulumi/random";

import { conf } from "../conf.ts";

export function createTunnel({ name }: { name: string }) {
  const secret = new random.RandomBytes(`${name}-secret`, {
    length: 256,
  });

  const tunnel = new cloudflare.ZeroTrustTunnelCloudflared(`${name}-tunnel`, {
    ...conf.cloudflare,
    name,
    tunnelSecret: secret.hex,
  });

  return tunnel;
}
