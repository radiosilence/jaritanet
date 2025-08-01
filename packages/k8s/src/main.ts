import * as cloudflare from "@pulumi/cloudflare";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { conf } from "./conf.ts";
import { env } from "./env.ts";
import { getKubeconfig } from "./kubeconfig.ts";
import { tunnelRef } from "./references.ts";
import { createCloudflared } from "./templates/cloudflared.ts";
import { createService } from "./templates/service.ts";

export default async function () {
  const namespace = conf.namespace;

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
          "pulumi.com/managed-by": conf.managedBy,
        },
      },
    },
    { provider },
  );

  const infraStackRef = new pulumi.StackReference(
    `${conf.infraStackPath}/${pulumi.getStack()}`,
  );
  const services = Object.fromEntries(
    Object.entries(conf.services)
      .filter(([, { hostname }]) => hostname && hostname.trim() !== "")
      .map(([name, { args, hostname, proxied }]) => {
        const service = createService(provider, name, args);

        if (hostname) {
          return [
            name,
            {
              hostname,
              proxied,
              service: pulumi.interpolate`http://${service.metadata.name}.${namespace}.svc.${conf.clusterDomain}`,
            },
          ];
        }
        return undefined;
      })
      .filter(
        (
          entry,
        ): entry is [
          string,
          {
            hostname: string;
            proxied: boolean;
            service: pulumi.Output<string>;
          },
        ] => entry !== undefined,
      ),
  );

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
