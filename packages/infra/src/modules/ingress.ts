import * as crypto from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { TraefikConfSchema } from "../conf.schemas.ts";

/**
 * Deploys the ingress stack into the K8s cluster:
 * - Traefik as the ingress controller with built-in ACME (Let's Encrypt via DNS-01)
 * - frp client (frpc) connecting back to the Hetzner gateway VPS
 *
 * Traefik handles TLS termination and hostname routing. frpc tunnels
 * ports 80+443 from the VPS to Traefik's service. No certs on the VPS.
 *
 * `httpsRemotePort` is where the gateway surfaces Traefik's 443: 8443 when Xray
 * owns the public :443 and uses frp as its decoy backend, else 443 directly.
 */
export function createIngress(
  provider: k8s.Provider,
  namespace: string,
  traefik: z.infer<typeof TraefikConfSchema>,
  vpsIp: pulumi.Output<string> | undefined,
  frpToken: pulumi.Output<string> | undefined,
  httpsRemotePort: number,
  cloudflareApiToken: string,
  exits: { name: string; port: number }[] = [],
) {
  // Cloudflare API token for Traefik's DNS-01 ACME solver
  const cfSecret = new k8s.core.v1.Secret(
    "cloudflare-api-token",
    {
      metadata: { name: "cloudflare-api-token" },
      stringData: {
        "api-token": cloudflareApiToken,
      },
    },
    { provider },
  );

  // Traefik via Helm — ingress controller with built-in Let's Encrypt
  const traefikRelease = new k8s.helm.v3.Release(
    "traefik",
    {
      chart: "traefik",
      namespace,
      repositoryOpts: {
        repo: "https://traefik.github.io/charts",
      },
      values: {
        ports: {
          web: {
            expose: { default: true },
            port: 8000,
            hostPort: 80,
          },
          websecure: {
            expose: { default: true },
            port: 8443,
            hostPort: 443,
          },
        },
        service: {
          type: "ClusterIP",
        },
        // ACME certificate resolver using Cloudflare DNS-01
        additionalArguments: [
          `--certificatesresolvers.letsencrypt.acme.email=${traefik.acmeEmail}`,
          "--certificatesresolvers.letsencrypt.acme.storage=/data/acme.json",
          "--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare",
          "--certificatesresolvers.letsencrypt.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53",
        ],
        env: [
          {
            name: "CF_DNS_API_TOKEN",
            valueFrom: {
              secretKeyRef: {
                key: "api-token",
                name: cfSecret.metadata.name,
              },
            },
          },
        ],
        persistence: {
          enabled: true,
          size: "128Mi",
        },
        // Single node with hostPort — can't rolling update because the
        // old pod holds the port. Kill it first, then start the new one.
        deployment: {
          strategy: "Recreate",
        },
        resources: {
          limits: {
            cpu: "250m",
            memory: "256Mi",
          },
        },
      },
      version: traefik.chartVersion,
    },
    { provider },
  );

  // frp client — only deployed when a gateway VPS exists.
  // Without it, traffic reaches Traefik directly (e.g. via port forwarding).
  if (vpsIp && frpToken) {
    // Use the Helm release's generated service name and service ports (not container ports)
    const traefikSvc = pulumi.interpolate`${traefikRelease.name}.${namespace}.svc.cluster.local`;

    // Punch each k8s exit's ss-rust port out to the gateway loopback (frps binds
    // remotePort; xray/detour reaches it at 127.0.0.1:<port>). Both tcp and udp
    // so the exit carries QUIC/HTTP3 — the whole point of frp over rathole.
    const exitProxies = exits
      .map((e) => {
        const addr = `exit-${e.name}.${namespace}.svc.cluster.local`;
        return ["tcp", "udp"]
          .map(
            (proto) => `
[[proxies]]
name = "exit-${e.name}-${proto}"
type = "${proto}"
localIP = "${addr}"
localPort = ${e.port}
remotePort = ${e.port}
`,
          )
          .join("");
      })
      .join("");

    const frpcConfig = pulumi.interpolate`serverAddr = "${vpsIp}"
serverPort = 7000
auth.method = "token"
auth.token = "${frpToken}"

[[proxies]]
name = "https"
type = "tcp"
localIP = "${traefikSvc}"
localPort = 443
remotePort = ${httpsRemotePort}

[[proxies]]
name = "http"
type = "tcp"
localIP = "${traefikSvc}"
localPort = 80
remotePort = 80
${exitProxies}`;

    const frpcConfigHash = frpcConfig.apply((c) =>
      crypto.createHash("sha256").update(c).digest("hex"),
    );

    const frpcConfigMap = new k8s.core.v1.ConfigMap(
      "frpc-config",
      {
        metadata: { name: "frpc" },
        data: {
          "frpc.toml": frpcConfig,
        },
      },
      { provider },
    );

    new k8s.apps.v1.Deployment(
      "frpc",
      {
        metadata: {
          labels: { app: "frpc" },
        },
        spec: {
          replicas: 1,
          selector: {
            matchLabels: { app: "frpc" },
          },
          template: {
            metadata: {
              // Roll the client when the config changes (new/removed exit) —
              // mounted ConfigMaps don't restart frpc on their own.
              annotations: { "jaritanet/config-hash": frpcConfigHash },
              labels: { app: "frpc" },
            },
            spec: {
              containers: [
                {
                  // Official upstream image (ENTRYPOINT frpc, no default CMD).
                  // Keep the tag in lockstep with gateway `frpVersion`.
                  args: ["-c", "/etc/frp/frpc.toml"],
                  image: "fatedier/frpc:v0.70.0",
                  name: "frpc",
                  resources: {
                    limits: {
                      cpu: "100m",
                      memory: "64Mi",
                    },
                  },
                  volumeMounts: [
                    {
                      mountPath: "/etc/frp",
                      name: "config",
                    },
                  ],
                },
              ],
              volumes: [
                {
                  configMap: {
                    name: frpcConfigMap.metadata.name,
                  },
                  name: "config",
                },
              ],
            },
          },
        },
      },
      { dependsOn: [traefikRelease], provider },
    );
  }

  return { traefikRelease };
}

/**
 * Creates a Traefik IngressRoute for a service.
 * Each service gets its own IngressRoute CRD pointing at its K8s Service,
 * with TLS handled by the shared letsencrypt cert resolver.
 */
export function createIngressRoute(
  provider: k8s.Provider,
  serviceName: string,
  hostname: string,
  namespace: string,
) {
  new k8s.apiextensions.CustomResource(
    `${serviceName}-ingress-route`,
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: {
        name: `${serviceName}-ingress`,
        namespace,
      },
      spec: {
        entryPoints: ["websecure"],
        routes: [
          {
            kind: "Rule",
            match: `Host(\`${hostname}\`)`,
            services: [
              {
                name: `${serviceName}-service`,
                port: 80,
              },
            ],
          },
        ],
        tls: {
          certResolver: "letsencrypt",
        },
      },
    },
    { provider },
  );

  // HTTP -> HTTPS redirect
  new k8s.apiextensions.CustomResource(
    `${serviceName}-ingress-redirect`,
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: {
        name: `${serviceName}-redirect`,
        namespace,
      },
      spec: {
        entryPoints: ["web"],
        routes: [
          {
            kind: "Rule",
            match: `Host(\`${hostname}\`)`,
            middlewares: [
              {
                name: "redirect-https",
              },
            ],
            services: [
              {
                name: `${serviceName}-service`,
                port: 80,
              },
            ],
          },
        ],
      },
    },
    { provider },
  );
}

/**
 * Traefik Middleware for HTTP -> HTTPS redirect, shared across all services.
 */
export function createRedirectMiddleware(
  provider: k8s.Provider,
  namespace: string,
) {
  new k8s.apiextensions.CustomResource(
    "redirect-https",
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "Middleware",
      metadata: {
        name: "redirect-https",
        namespace,
      },
      spec: {
        redirectScheme: {
          permanent: true,
          scheme: "https",
        },
      },
    },
    { provider },
  );
}

/**
 * Deploys a lightweight pod that monitors the server's external IP.
 * When the IP changes (e.g. ISP rotation, internet restored after outage),
 * it triggers the CI/CD workflow to update DNS records.
 * Only deployed if a GitHub deploy token is available.
 */
export function createIpWatcher(
  provider: k8s.Provider,
  namespace: string,
  githubToken: string,
  githubRepo: string,
) {
  const script = `#!/bin/sh
LAST_IP=""
while true; do
  IP=$(curl -4 -s --connect-timeout 5 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | grep '^ip=' | cut -d= -f2)
  if [ -n "$IP" ] && [ "$IP" != "$LAST_IP" ]; then
    if [ -n "$LAST_IP" ]; then
      echo "$(date): IP changed $LAST_IP -> $IP, triggering deploy"
      curl -s -X POST \\
        -H "Authorization: token $GITHUB_TOKEN" \\
        -H "Accept: application/vnd.github.v3+json" \\
        "https://api.github.com/repos/$GITHUB_REPO/actions/workflows/ci-cd.yml/dispatches" \\
        -d '{"ref":"main"}'
    else
      echo "$(date): Initial IP: $IP"
    fi
    LAST_IP="$IP"
  fi
  sleep 60
done
`;

  const configMap = new k8s.core.v1.ConfigMap(
    "ip-watcher-script",
    {
      metadata: { name: "ip-watcher" },
      data: { "watch.sh": script },
    },
    { provider },
  );

  const secret = new k8s.core.v1.Secret(
    "ip-watcher-github-token",
    {
      metadata: { name: "ip-watcher-github" },
      stringData: { token: githubToken },
    },
    { provider },
  );

  new k8s.apps.v1.Deployment(
    "ip-watcher",
    {
      metadata: {
        labels: { app: "ip-watcher" },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "ip-watcher" } },
        template: {
          metadata: { labels: { app: "ip-watcher" } },
          spec: {
            containers: [
              {
                name: "watcher",
                image: "curlimages/curl:latest",
                command: ["sh", "/scripts/watch.sh"],
                env: [
                  {
                    name: "GITHUB_TOKEN",
                    valueFrom: {
                      secretKeyRef: {
                        name: secret.metadata.name,
                        key: "token",
                      },
                    },
                  },
                  { name: "GITHUB_REPO", value: githubRepo },
                ],
                resources: {
                  limits: { cpu: "10m", memory: "16Mi" },
                },
                volumeMounts: [{ name: "scripts", mountPath: "/scripts" }],
              },
            ],
            volumes: [
              {
                name: "scripts",
                configMap: { name: configMap.metadata.name },
              },
            ],
          },
        },
      },
    },
    { provider },
  );
}
