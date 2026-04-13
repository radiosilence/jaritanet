import * as k8s from "@pulumi/kubernetes";
import { conf } from "./conf.ts";
import { env } from "./env.ts";
import { getKubeconfig } from "./kubeconfig.ts";
import {
  createBlueskyRecords,
  createFastmailRecords,
  createServiceRecord,
} from "./modules/dns.ts";
import { createGateway } from "./modules/gateway.ts";
import {
  createIngress,
  createIngressRoute,
  createRedirectMiddleware,
} from "./modules/ingress.ts";
import { createService } from "./templates/service.ts";

const dnsModules = {
  bluesky: createBlueskyRecords,
  fastmail: createFastmailRecords,
} as const;

export default async function () {
  const { namespace } = conf;

  // --- Gateway: Hetzner VPS + rathole server ---
  const { vpsIp, ratholeToken } = createGateway(conf.gateway);

  // --- DNS: zone modules (fastmail, bluesky) ---
  for (const zone of conf.zones) {
    for (const mod of zone.modules) {
      if (mod === "fastmail") {
        dnsModules[mod](zone, conf.fastmail);
      } else {
        dnsModules[mod](zone, conf.bluesky);
      }
    }
  }

  // --- Kubernetes provider ---
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
    { kubeconfig, namespace },
    {
      customTimeouts: {
        create: "5m",
        delete: "5m",
        update: "5m",
      },
    },
  );

  new k8s.core.v1.Namespace(
    namespace,
    {
      metadata: {
        annotations: { "pulumi.com/managed-by": conf.managedBy },
        labels: {
          name: namespace,
          "kubernetes.io/metadata.name": namespace,
        },
        name: namespace,
      },
    },
    { provider },
  );

  // --- Ingress: Traefik + rathole client ---
  createIngress(
    provider,
    namespace,
    conf.traefik,
    vpsIp,
    ratholeToken.result,
    env.CLOUDFLARE_API_TOKEN,
  );

  createRedirectMiddleware(provider, namespace);

  // --- Services + DNS records + ingress routes ---
  const services = Object.entries(conf.services)
    .filter(([, { hostname }]) => hostname && hostname.trim() !== "")
    .map(([name, { args, hostname }]) => {
      const service = createService(provider, name, args);

      // DNS A record -> gateway VPS
      const zoneName = hostname!.split(".").slice(-2).join(".");
      const zone = conf.zones.find((z) => z.name === zoneName);
      if (zone) {
        createServiceRecord(vpsIp, zone, hostname!);
      }

      // Traefik IngressRoute for this service
      createIngressRoute(provider, name, hostname!, namespace);

      return [name, { hostname, service: service.metadata.name }] as const;
    });

  return {
    namespace,
    services: Object.fromEntries(services),
    vpsIp,
  };
}
