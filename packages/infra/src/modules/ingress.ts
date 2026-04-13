import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { TraefikConfSchema } from "../conf.schemas.ts";

/**
 * Deploys the ingress stack into the K8s cluster:
 * - Traefik as the ingress controller with built-in ACME (Let's Encrypt via DNS-01)
 * - Rathole client connecting back to the Hetzner gateway VPS
 *
 * Traefik handles TLS termination and hostname routing. Rathole tunnels
 * ports 80+443 from the VPS to Traefik's service. No certs on the VPS.
 */
export function createIngress(
  provider: k8s.Provider,
  namespace: string,
  traefik: z.infer<typeof TraefikConfSchema>,
  vpsIp: pulumi.Output<string> | undefined,
  ratholeToken: pulumi.Output<string> | undefined,
  cloudflareApiToken: string,
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

  // Rathole client — only deployed when a gateway VPS exists.
  // Without it, traffic reaches Traefik directly (e.g. via port forwarding).
  if (vpsIp && ratholeToken) {
    const ratholeConfig = pulumi.interpolate`[client]
remote_addr = "${vpsIp}:2333"
default_token = "${ratholeToken}"

[client.services.https]
type = "tcp"
local_addr = "traefik.${namespace}.svc.cluster.local:8443"

[client.services.http]
type = "tcp"
local_addr = "traefik.${namespace}.svc.cluster.local:8000"
`;

    const ratholeConfigMap = new k8s.core.v1.ConfigMap(
      "rathole-client-config",
      {
        metadata: { name: "rathole-client" },
        data: {
          "client.toml": ratholeConfig,
        },
      },
      { provider },
    );

    new k8s.apps.v1.Deployment(
      "rathole-client",
      {
        metadata: {
          labels: { app: "rathole-client" },
        },
        spec: {
          replicas: 1,
          selector: {
            matchLabels: { app: "rathole-client" },
          },
          template: {
            metadata: {
              labels: { app: "rathole-client" },
            },
            spec: {
              containers: [
                {
                  args: ["--client", "/etc/rathole/client.toml"],
                  command: ["rathole"],
                  image: "rapiz1/rathole:latest",
                  name: "rathole",
                  resources: {
                    limits: {
                      cpu: "100m",
                      memory: "64Mi",
                    },
                  },
                  volumeMounts: [
                    {
                      mountPath: "/etc/rathole",
                      name: "config",
                    },
                  ],
                },
              ],
              volumes: [
                {
                  configMap: {
                    name: ratholeConfigMap.metadata.name,
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
