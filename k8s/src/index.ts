import type * as cloudflare from "@pulumi/cloudflare";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  type CloudflaredConf,
  CloudflaredConfSchema,
  type ServiceConf,
  ServicesArraySchema,
} from "./config.schemas";
import { getKubeconfig } from "./kubeconfig";
import {
  createCloudflared,
  createLocalStorageService,
  createStaticService,
} from "./templates";

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

function createService(serviceConf: ServiceConf) {
  const { name, template, args } = serviceConf;

  switch (template) {
    case "local-storage":
      return createLocalStorageService(provider, name, args);

    case "static":
      return createStaticService(provider, name, args);
  }
}

export const services = ServicesArraySchema.parse(
  config.requireObject("services")
).map((conf) => {
  const service = createService(conf);

  return {
    hostname: conf.hostname,
    service: pulumi.interpolate`http://${service.metadata.name}.${namespace}.svc.cluster.local`,
  };
});

const tunnelOutput = new pulumi.StackReference(
  "radiosilence/jaritanet/main"
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
