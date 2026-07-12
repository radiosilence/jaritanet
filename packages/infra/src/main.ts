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
import { createEdge } from "./modules/edge.ts";
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

// One entry per sing-box node (primary gateway + every edge). The client
// profile is rendered from this; exported as the `singboxNodes` stack output.
type SingboxNode = {
  name: string;
  server: pulumi.Input<string>;
  hysteria: {
    authPassword: pulumi.Output<string>;
    obfsPassword: pulumi.Output<string>;
    port: number;
    sni: string;
  };
  reality: {
    publicKey: pulumi.Output<string>;
    serverName: string;
    shortId: pulumi.Output<string>;
    uuid: pulumi.Output<string>;
  };
};

export default async function () {
  const { namespace } = conf;
  let dnsTarget: pulumi.Output<string> | undefined;
  let ratholeToken: pulumi.Output<string> | undefined;
  let gatewayProvider: string | undefined;
  let xray: ReturnType<typeof createGateway>["xray"];
  let hysteria: ReturnType<typeof createGateway>["hysteria"];

  // sing-box nodes (primary gateway + every edge) — the single source the
  // client profile is rendered from. Marked secret; consumed by the singbox
  // ansible role via `pulumi stack output singboxNodes`.
  const nodes: SingboxNode[] = [];

  if (env.HCLOUD_TOKEN) {
    const gatewayConf = conf.gateway ?? GatewayConfSchema.parse({});
    const gw = createGateway(gatewayConf);
    dnsTarget = gw.vpsIp;
    ratholeToken = gw.ratholeToken.result;
    gatewayProvider = "hetzner";
    xray = gw.xray;
    hysteria = gw.hysteria;

    // The primary is a node too: clients connect by IP, and its REALITY decoy
    // is its own reverse-proxied site (unlike edges, which use an external one).
    if (gw.hysteria && gw.xray && gatewayConf.hysteria && gatewayConf.xray) {
      nodes.push({
        name: "primary",
        server: gw.vpsIp,
        hysteria: {
          authPassword: gw.hysteria.authPassword,
          obfsPassword: gw.hysteria.obfsPassword,
          port: gatewayConf.hysteria.port,
          sni: gatewayConf.hysteria.sni,
        },
        reality: {
          publicKey: gw.xray.publicKey,
          serverName: gatewayConf.xray.serverName,
          shortId: gw.xray.shortId,
          uuid: gw.xray.uuid,
        },
      });
    }

    // Edge boxes — pure VPN nodes. Each gets a <name>.<zone> A record and a
    // picker entry. Tailnet relay only when TS_AUTHKEY is present.
    const edgeAuthKey = env.TS_AUTHKEY
      ? pulumi.secret(env.TS_AUTHKEY)
      : undefined;
    for (const edge of conf.edges) {
      const e = createEdge(edge, edgeAuthKey);
      const hostname = `${edge.name}.${edge.zone}`;
      const zone = conf.zones.find((z) => z.name === edge.zone);
      if (zone) {
        createServiceRecord(e.vpsIp, zone, hostname);
      }
      nodes.push({
        name: edge.name,
        server: hostname,
        hysteria: {
          authPassword: e.hysteria.authPassword,
          obfsPassword: e.hysteria.obfsPassword,
          port: edge.hysteria.port,
          sni: edge.hysteria.sni,
        },
        reality: {
          publicKey: e.xray.publicKey,
          serverName: edge.reality.serverName,
          shortId: e.xray.shortId,
          uuid: e.xray.uuid,
        },
      });
    }
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
    ...(xray && {
      xrayPublicKey: xray.publicKey,
      xrayServerName: conf.gateway?.xray?.serverName,
      xrayShareUrl: xray.shareUrl,
      xrayShortId: xray.shortId,
      xrayUuid: xray.uuid,
    }),
    ...(hysteria && {
      hysteriaShareUrl: hysteria.shareUrl,
    }),
    ...(nodes.length > 0 && { singboxNodes: pulumi.secret(nodes) }),
  };
}
