import * as cloudflare from "@pulumi/cloudflare";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { z } from "zod/v4";
import { conf } from "./conf.ts";
import { bluesky } from "./routes-modules/bluesky.ts";
import { fastmail } from "./routes-modules/fastmail.ts";
import { createCloudflared } from "./templates/cloudflared.ts";
import { createService } from "./templates/service.ts";
import { createZone, getRecord, getServiceIngress } from "./tunnels/service.ts";
import { createTunnelConfig } from "./tunnels/tunnel-config.ts";

// Environment validation schema
const EnvSchema = z.object({
  KUBE_HOST: z.string().min(1, "KUBE_HOST is required"),
  KUBE_API_PORT: z.string().min(1, "KUBE_API_PORT is required"),
  KUBE_TOKEN: z.string().min(1, "KUBE_TOKEN is required"),
});

const env = EnvSchema.parse(process.env);

const getKubeconfig = ({
  host,
  port = 16443,
  token,
}: {
  host: string;
  port?: string | number;
  token: string;
}) => ({
  apiVersion: "v1",
  kind: "Config",
  clusters: [
    {
      cluster: {
        server: `https://${host}:${port}`,
        "insecure-skip-tls-verify": true,
      },
      name: "microk8s-cluster",
    },
  ],
  contexts: [
    {
      context: {
        cluster: "microk8s-cluster",
        user: "admin",
      },
      name: "microk8s",
    },
  ],
  "current-context": "microk8s",
  users: [
    {
      name: "admin",
      user: { token },
    },
  ],
});

// Create tunnel
const secret = new random.RandomBytes(`${conf.tunnel.name}-secret`, {
  length: 256,
});

export const tunnel = new cloudflare.ZeroTrustTunnelCloudflared(
  `${conf.tunnel.name}-tunnel`,
  {
    ...conf.cloudflare,
    name: conf.tunnel.name,
    tunnelSecret: secret.hex,
  },
);

export default async function () {
  // K8s setup
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

  // Create services
  const services = Object.fromEntries(
    Object.entries(conf.services).map(([name, { args, hostname, proxied }]) => {
      const service = createService(provider, name, args);
      return [
        name,
        {
          hostname,
          proxied,
          service: pulumi.interpolate`http://${service.metadata.name}.${namespace}.svc.${conf.clusterDomain}`,
        },
      ];
    }),
  );

  // Get tunnel token and create cloudflared using pulumi.all
  const cloudflared = pulumi
    .all([tunnel.id, conf.cloudflare.accountId])
    .apply(async ([tunnelId, accountId]) => {
      const { token } = await cloudflare.getZeroTrustTunnelCloudflaredToken({
        accountId,
        tunnelId,
      });
      return createCloudflared(
        provider,
        conf.cloudflared.name,
        token,
        conf.cloudflared.args,
      );
    });

  // Routes setup
  const modules = { bluesky, fastmail };

  for (const zone of conf.zones) {
    for (const module of zone.modules) {
      modules[module](zone);
    }
  }

  // Create ingresses using pulumi.all to handle outputs properly
  const serviceValues = Object.values(services);
  const servicesData = pulumi
    .all(serviceValues.map((s) => s.service))
    .apply((serviceUrls) => {
      return Object.entries(services).map(([name, service], index) => ({
        name,
        hostname: service.hostname,
        proxied: service.proxied,
        service: serviceUrls[index],
      }));
    });

  const ingresses = servicesData.apply((servicesArray) =>
    servicesArray.map(({ hostname, service }) =>
      getServiceIngress(hostname, service || ""),
    ),
  );

  // Create DNS records and tunnel config
  servicesData.apply((servicesArray) => {
    for (const service of servicesArray) {
      const { zoneName } = getRecord(service.hostname);
      const zone = conf.zones.find((z) => z.name === zoneName);

      if (!zone) {
        throw new Error(`Zone ${zoneName} not found`);
      }

      tunnel.id.apply((tunnelId) => {
        createZone(`${tunnelId}.cfargotunnel.com`, zone, service);
      });
    }
  });

  pulumi.all([tunnel.id, ingresses]).apply(([tunnelId, ingressList]) => {
    createTunnelConfig(conf.cloudflare.accountId, tunnelId, ingressList);
  });

  return {
    tunnel: {
      id: tunnel.id,
      name: tunnel.name,
    },
    namespace,
    cloudflaredStatus: cloudflared.apply((c) => c.status),
    services: servicesData,
  };
}
