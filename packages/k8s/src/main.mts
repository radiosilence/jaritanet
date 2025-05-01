import * as cloudflare from "@pulumi/cloudflare";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { conf } from "./conf.mts";
import { env } from "./env.mts";
import { getKubeconfig } from "./kubeconfig.mts";
import { tunnelRef } from "./references.mts";
import { createCloudflared } from "./templates/cloudflared.mts";
import { createService } from "./templates/service.mts";

const namespace = "jaritanet";

const kubeconfig = JSON.stringify(
  getKubeconfig({
    host: env.KUBE_HOST,
    port: env.KUBE_API_PORT,
    token: atob(env.KUBE_TOKEN),
  }),
  null,
  2,
);

// Initialize Kubernetes provider with retry logic
const provider = new k8s.Provider(
  "provider",
  {
    kubeconfig,
    namespace,
  },
  {
    customTimeouts: {
      create: "5m",
      update: "5m",
      delete: "5m",
    },
  },
);

new k8s.core.v1.Namespace(
  namespace,
  {
    metadata: {
      name: namespace,
      labels: {
        name: namespace,
        "kubernetes.io/metadata.name": namespace,
      },
      annotations: {
        "pulumi.com/managed-by": "jaritanet",
      },
    },
  },
  { provider },
);

const infraStackRef = new pulumi.StackReference(
  `radiosilence/jaritanet/${pulumi.getStack()}`,
);

export default async function () {
  const services = conf.services.map(({ name, args, hostname, proxied }) => {
    const service = createService(provider, name, args);

    return {
      hostname,
      proxied,
      service: pulumi.interpolate`http://${service.metadata.name}.${namespace}.svc.cluster.local`,
    };
  });

  const { id: tunnelId } = await tunnelRef(infraStackRef);

  const cloudflaredConf = conf.cloudflared;

  const { token } = await cloudflare.getZeroTrustTunnelCloudflaredToken({
    accountId: conf.cloudflare.accountId,
    tunnelId,
  });

  // Create cloudflared deployment with proper error handling
  const cloudflared = createCloudflared(
    provider,
    cloudflaredConf.name,
    token,
    cloudflaredConf.args,
  );

  return {
    services,
    namespace,
    cloudflaredStatus: cloudflared.status,
  };
}
