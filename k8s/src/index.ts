import type * as cloudflare from "@pulumi/cloudflare";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createCloudflared, createLocalServer } from "./templates";
import type { CloudflaredConf, LocalServerConf } from "./types";

const config = new pulumi.Config();

export const namespace = "jaritanet";

const provider = new k8s.Provider("provider", {
  // renderYamlToDirectory: "rendered/",
  namespace,
});

new k8s.core.v1.Namespace(
  namespace,
  {
    metadata: {
      name: namespace,
    },
  },
  { provider }
);

export const services = config
  .requireObject<LocalServerConf[]>("local-servers")
  .map(({ name, args, hostname }) => ({
    hostname,
    service: pulumi.interpolate`http://${
      createLocalServer(provider, name, args).name
    }.${namespace}.svc.cluster.local`,
  }));

const tunnelOutput = new pulumi.StackReference(
  "radiosilence/jaritanet/main"
).requireOutput(
  "tunnel"
) as pulumi.Output<cloudflare.ZeroTrustTunnelCloudflared>;

const cloudflared = config.requireObject<CloudflaredConf>("cloudflared");

createCloudflared(provider, cloudflared.name, {
  ...cloudflared.args,
  token: tunnelOutput.apply((t) => t.tunnelToken),
});
