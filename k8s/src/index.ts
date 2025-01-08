import type * as cloudflare from "@pulumi/cloudflare";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { CloudflaredConf, ServiceConf } from "./conf";
import { kubeconfig } from "./kubeconfig";
import {
  createCloudflared,
  createLocalStorageService,
  createStaticService,
} from "./templates";

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

export const services = config
  .requireObject<ServiceConf[]>("services")
  .map(({ name, args, hostname, template }) => {
    let service: k8s.core.v1.Service;

    switch (template) {
      case "local-storage": {
        service = createLocalStorageService(provider, name, args);
        break;
      }
      case "static": {
        service = createStaticService(provider, name, args);
        break;
      }
    }

    return {
      hostname,
      service: pulumi.interpolate`${service.metadata.name}.${namespace}.svc.cluster.local`,
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
