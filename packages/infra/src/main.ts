import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { conf } from "./conf.ts";
import { GatewayConfSchema } from "./conf.schemas.ts";
import { env } from "./env.ts";
import { getKubeconfig } from "./kubeconfig.ts";
import {
  createBlueskyRecords,
  createFastmailRecords,
  createServiceRecord,
} from "./modules/dns.ts";
import { createOciGateway } from "./modules/gateway-oci.ts";
import { createGateway } from "./modules/gateway.ts";
import {
  createIngress,
  createIngressRoute,
  createIpWatcher,
  createRedirectMiddleware,
} from "./modules/ingress.ts";
import { createService } from "./templates/service.ts";

const dnsModules = {
  bluesky: createBlueskyRecords,
  fastmail: createFastmailRecords,
} as const;

export default async function () {
  const { namespace } = conf;
  const ratholeVersion = conf.gateway?.ratholeVersion ?? "v0.5.0";

  // --- Gateway: auto-detect provider from available credentials ---
  // Priority: Hetzner > OCI > externalIp > no gateway (direct hostPort)
  let dnsTarget: pulumi.Output<string> | undefined;
  let ratholeToken: pulumi.Output<string> | undefined;
  let gatewayProvider: string | undefined;

  if (env.HCLOUD_TOKEN) {
    const gw = createGateway(conf.gateway ?? GatewayConfSchema.parse({}));
    dnsTarget = gw.vpsIp;
    ratholeToken = gw.ratholeToken.result;
    gatewayProvider = "hetzner";
  } else if (env.OCI_TENANCY_OCID) {
    const gw = createOciGateway(ratholeVersion);
    dnsTarget = gw.vpsIp;
    ratholeToken = gw.ratholeToken.result;
    gatewayProvider = "oci";
  } else if (conf.externalIp) {
    dnsTarget = pulumi.output(conf.externalIp);
  }

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

  // --- Ingress: Traefik always on hostPort 443 + rathole client if gateway exists ---
  createIngress(
    provider,
    namespace,
    conf.traefik,
    dnsTarget,
    ratholeToken,
    env.CLOUDFLARE_API_TOKEN,
  );

  createRedirectMiddleware(provider, namespace);

  // IP watcher — triggers deploy when external IP changes
  if (env.DEPLOY_TOKEN) {
    createIpWatcher(
      provider,
      namespace,
      env.DEPLOY_TOKEN,
      env.GITHUB_REPOSITORY,
    );
  }

  // --- Services + DNS records + ingress routes ---
  const services = Object.entries(conf.services)
    .filter(([, { hostname }]) => hostname && hostname.trim() !== "")
    .map(([name, { args, hostname }]) => {
      const service = createService(provider, name, args);

      if (dnsTarget) {
        const zoneName = hostname!.split(".").slice(-2).join(".");
        const zone = conf.zones.find((z) => z.name === zoneName);
        if (zone) {
          createServiceRecord(dnsTarget, zone, hostname!);
        }
      }

      createIngressRoute(provider, name, hostname!, namespace);

      return [name, { hostname, service: service.metadata.name }] as const;
    });

  return {
    ...(gatewayProvider && { gatewayProvider }),
    namespace,
    services: Object.fromEntries(services),
    ...(dnsTarget && { vpsIp: dnsTarget }),
  };
}
