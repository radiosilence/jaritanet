import type * as cloudflare from "@pulumi/cloudflare";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { kubeconfig } from "./kubeconfig";
import { createCloudflared, createLocalServer } from "./templates";
import type { CloudflaredConf, ServiceConf } from "./types";

const config = new pulumi.Config();

export const namespace = "jaritanet";

const provider = new k8s.Provider("provider", {
  kubeconfig: kubeconfig({
    host: process.env.KUBE_HOST ?? "",
    port: process.env.KUBE_API_PORT ?? 16443,
    token: process.env.KUBE_TOKEN ?? "",
  }),
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

const templates = {
  "local-server": createLocalServer,
};

export const services = config
  .requireObject<ServiceConf[]>("services")
  .map(({ name, args, hostname, template }) => {
    const service = templates[template](provider, name, args);

    return {
      hostname,
      service: pulumi.interpolate`${service.name}.${namespace}.svc.cluster.local`,
    };
  });

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
