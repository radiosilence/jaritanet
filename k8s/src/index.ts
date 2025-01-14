import type * as cloudflare from "@pulumi/cloudflare";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  type CloudflaredConf,
  CloudflaredConfSchema,
  ServicesArraySchema,
} from "./config.schemas";
import { getKubeconfig } from "./kubeconfig";
import { createCloudflared, createService } from "./templates";

const config = new pulumi.Config();

export const namespace = "jaritanet";

if (!process.env.KUBE_HOST) {
  throw new Error("KUBE_HOST is required");
}

if (!process.env.KUBE_API_PORT) {
  throw new Error("KUBE_API_PORT is required");
}

if (!process.env.KUBE_TOKEN) {
  throw new Error("KUBE_TOKEN is required");
}

const kubeconfig = JSON.stringify(
  getKubeconfig({
    host: process.env.KUBE_HOST,
    port: process.env.KUBE_API_PORT,
    token: atob(process.env.KUBE_TOKEN),
  }),
  null,
  2
);

const provider = new k8s.Provider("provider", {
  kubeconfig,
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

export const services = ServicesArraySchema.parse(
  config.requireObject("services")
).map(({ name, args, hostname, proxied }) => {
  const service = createService(provider, name, args);

  return {
    hostname,
    proxied,
    service: pulumi.interpolate`http://${service.metadata.name}.${namespace}.svc.cluster.local`,
  };
});

const tunnelOutput = new pulumi.StackReference(
  `radiosilence/jaritanet/${pulumi.getStack()}`
).requireOutput(
  "tunnel"
) as pulumi.Output<cloudflare.ZeroTrustTunnelCloudflared>;

const cloudflaredConf = CloudflaredConfSchema.parse(
  config.requireObject<CloudflaredConf>("cloudflared")
);

createCloudflared(
  provider,
  cloudflaredConf.name,
  tunnelOutput.apply((t) => t.tunnelToken)
);
